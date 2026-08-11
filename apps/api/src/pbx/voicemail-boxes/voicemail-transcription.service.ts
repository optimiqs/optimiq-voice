import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { and, eq, voicemailMessage } from "@optimiq-voice/pbx-db";
import { ObjectNotFoundError } from "../../storage";
import { PBX_TRANSCRIPTION_PROVIDER, PBX_TRANSCRIPTION_SETTINGS } from "../shared/pbx.tokens";
import { PBX_DATABASE, PBX_VOICEMAIL_STORE } from "../shared/pbx.tokens";
import { VoicemailEmailService } from "./voicemail-email.service";
import type { ObjectStore } from "../../storage";
import type {
	TranscriptionAudio,
	TranscriptionEnv,
	TranscriptionProvider,
} from "../../transcription";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/** Why a message was not transcribed. Returned rather than thrown; every one of these is normal. */
export type VoicemailTranscriptionSkip =
	| "provider-disabled"
	| "no-such-message"
	| "not-pending"
	| "audio-missing";

/**
 * A string discriminant rather than a boolean, for the reason `voicemail-email.service.ts` records:
 * `apps/api`'s tooling tsconfig relaxes `strictNullChecks`, and without it a union is not narrowed
 * by a boolean-literal member.
 */
export type VoicemailTranscriptionOutcome =
	| { readonly outcome: "done"; readonly characters: number; readonly attempts: number }
	| { readonly outcome: "skipped"; readonly reason: VoicemailTranscriptionSkip }
	| { readonly outcome: "failed"; readonly attempts: number };

/** One message waiting for the worker. Deliberately not the audio — see {@link transcribeNow}. */
interface TranscriptionJob {
	readonly organizationId: string;
	readonly mailboxId: string;
	readonly messageId: string;
	/**
	 * Whether this message's voicemail-to-email notification is waiting on this transcription.
	 *
	 * Set by the consumer when the organization asked for the transcript IN the mail; see
	 * {@link VoicemailTranscriptionService.enqueue}.
	 */
	readonly deferredEmail: boolean;
}

/**
 * Voicemail transcription, downstream of the row and downstream of the ack.
 *
 * ## The one rule: this may never cost a message
 *
 * A voicemail is a customer talking to a business. A transcript is a convenience on top of it. So
 * every design decision in this file resolves the same way when they conflict — the message wins.
 * Concretely:
 *
 * - {@link enqueue} is `void` and cannot throw. It is called AFTER `message.ack()` and after every
 *   other post-ack step in `voicemail-consumer.ts`, so nothing here is upstream of anything that
 *   files a row, lights a lamp or sends a notification.
 * - The worker runs on its own loop rather than on the JetStream consume loop. That loop is
 *   `for await (…) { await handle(…) }` — strictly sequential — so awaiting a transcription there
 *   would put a provider's latency, and its retry backoff, directly in front of the NEXT caller's
 *   voicemail. A burst of ten messages behind one slow transcription is ten late MWI lamps.
 * - A failure writes `transcription_status = 'failed'` and stops. It never NAKs, because the
 *   delivery it would NAK has already been acked and redelivering it would re-run an insert whose
 *   duplicate detection is the only thing between a user and seeing one voicemail twice.
 *
 * ## Why the queue is in memory, and what a full queue means
 *
 * JetStream is already the durable queue; adding a second durable queue for the derived artifact
 * would mean a stream, a consumer and a redelivery policy to keep transcripts that nothing on the
 * call path needs. What this queue is for is decoupling the two latencies, which memory does fine.
 *
 * The consequence is that a restart loses the backlog, and the answer is the row rather than the
 * queue: a message whose transcription has not finished is `pending` in the database, indexed by
 * `voicemail_message_transcription_pending_idx` precisely so a back-fill can find it. Same for an
 * over-full queue — {@link enqueue} refuses and leaves the row `pending` rather than marking it
 * `failed`, because "nobody got to it" and "a provider rejected it" are different facts and an
 * operator restarting a wedged provider wants only the first set retried.
 *
 * That back-fill is `voicemail-transcription-sweeper.service.ts`, and it feeds reclaimed rows back
 * through {@link enqueue} rather than transcribing them itself. The one thing this class owes it is
 * {@link heldMessageIds}: a sweep must not take a message this process is mid-request on, and the
 * age of the row cannot tell it that.
 *
 * ## Tenant safety: the object key comes from the ROW, not from the event
 *
 * {@link TranscriptionJob} carries three ids and no key. The worker re-reads `object_key` inside
 * `withTenantScope`, so RLS has proved the message belongs to that organization before anything
 * opens a byte of audio. Taking the key off the NATS envelope instead would work identically on
 * every correct message and would make a forged or mis-subjected event able to point this process
 * at another tenant's object — the class of bug `voicemail-consumer.ts` already terminates messages
 * to avoid. The provider then receives a closure over that one object and never an object store;
 * `src/transcription/transcription-provider.ts` explains why that is the port's shape.
 */
@Injectable()
export class VoicemailTranscriptionService implements OnApplicationShutdown {
	private readonly queue: TranscriptionJob[] = [];
	/**
	 * Every message id this process is holding — queued or in flight.
	 *
	 * The in-process half of "the back-fill must not take a message somebody is already working on".
	 * It is exact here and says nothing about another replica, which is what the grace window and the
	 * claim column in `voicemail-transcription-backfill.ts` are for. A set rather than a scan of
	 * {@link queue} because the in-flight job has already been shifted off it, and the in-flight job
	 * is precisely the one a sweep must not duplicate.
	 */
	private readonly held = new Set<string>();
	/**
	 * The deferral timers, by message id.
	 *
	 * One per message whose notification is waiting on a transcript, armed when the job is accepted
	 * AND when it is refused — a message the queue dropped still owes somebody an email, and the
	 * budget is what guarantees the mail is late rather than absent.
	 */
	private readonly emailTimers = new Map<string, NodeJS.Timeout>();
	private draining = false;
	private stopped = false;
	private transcribed = 0;
	private skipped = 0;
	private failed = 0;
	private dropped = 0;
	private deferredEmails = 0;
	private timedOutEmails = 0;

	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(PBX_VOICEMAIL_STORE) private readonly store: ObjectStore,
		@Inject(PBX_TRANSCRIPTION_PROVIDER) private readonly provider: TranscriptionProvider,
		@Inject(PBX_TRANSCRIPTION_SETTINGS) private readonly settings: TranscriptionEnv,
		@Inject(VoicemailEmailService) private readonly email: VoicemailEmailService,
	) {}

	get stats(): {
		readonly enabled: boolean;
		readonly queued: number;
		readonly transcribed: number;
		readonly skipped: number;
		readonly failed: number;
		readonly dropped: number;
		/** Notifications this process held back to wait for a transcript. */
		readonly deferredEmails: number;
		/** Of those, the ones the budget expired on before the transcription settled. */
		readonly timedOutEmails: number;
	} {
		return {
			enabled: this.provider.enabled,
			queued: this.queue.length,
			transcribed: this.transcribed,
			skipped: this.skipped,
			failed: this.failed,
			dropped: this.dropped,
			deferredEmails: this.deferredEmails,
			timedOutEmails: this.timedOutEmails,
		};
	}

	/** Whether anything would happen at all. The consumer checks this before marking a row pending. */
	get enabled(): boolean {
		return this.provider.enabled;
	}

	/**
	 * The message ids this process is holding, for the back-fill to exclude.
	 *
	 * A snapshot rather than the live set, so a sweep that is building a query cannot observe it
	 * changing underneath.
	 */
	heldMessageIds(): readonly string[] {
		return [...this.held];
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		// The in-flight job is abandoned rather than awaited: its row stays `pending`, which is the
		// state a back-fill looks for. Blocking shutdown on a provider that is already slow is how a
		// deploy turns into a stuck container.
		this.queue.length = 0;
		this.held.clear();
		// The deferral timers go with it, and the rows they would have settled stay `pending` with a
		// null `email_sent_at` — which is exactly the pair the back-fill reclaims. Firing them during
		// a shutdown would mean racing a mail send against a closing database pool.
		for (const timer of this.emailTimers.values()) {
			clearTimeout(timer);
		}
		this.emailTimers.clear();
	}

	/**
	 * Hands a filed message to the worker. Never throws, never blocks, never awaits a provider.
	 *
	 * `void` rather than `Promise<void>` is the signature doing the work: a caller cannot
	 * accidentally `await` this and put a transcription in front of the message that comes after it.
	 * See this class's header.
	 *
	 * ## `deferredEmail`, and why the timer is armed before the queue is consulted
	 *
	 * When the organization asked for the transcript IN the notification, the consumer does NOT send
	 * the mail at filing time — it hands the decision here, and whichever of the worker or the budget
	 * timer gets there first sends it. The timer is armed BEFORE the queue-limit check on purpose: a
	 * message the queue refused is exactly the message whose notification nothing else is going to
	 * send within the budget, and dropping the timer with the job would turn a full queue into
	 * silently missing mail. Both paths converge on one `email_sent_at` compare-and-set, so arming a
	 * timer that the worker beats costs one refused UPDATE.
	 */
	enqueue(
		organizationId: string,
		mailboxId: string,
		messageId: string,
		options: { readonly deferredEmail?: boolean } = {},
	): void {
		if (this.stopped) {
			return;
		}
		if (options.deferredEmail === true) {
			this.armEmailBudget(organizationId, mailboxId, messageId);
		}
		if (!this.provider.enabled) {
			return;
		}
		if (this.queue.length >= this.settings.queueLimit) {
			this.dropped += 1;
			logger.warn(
				{
					organizationId,
					messageId,
					queueLimit: this.settings.queueLimit,
				},
				"the transcription queue is full; this message stays `pending` for a back-fill",
			);
			return;
		}
		this.held.add(messageId);
		this.queue.push({
			organizationId,
			mailboxId,
			messageId,
			deferredEmail: options.deferredEmail === true,
		});
		// Fire-and-forget: `drain` owns its own failures, and awaiting it here is precisely what this
		// method exists not to do.
		void this.drain();
	}

	/**
	 * The worker loop.
	 *
	 * One job at a time and one loop in the process. Serial because the thing being protected is the
	 * control plane's event loop rather than throughput: voicemail arrives at human speed, a
	 * transcription is a network wait plus a few megabytes of heap, and N of those in parallel is a
	 * memory profile nobody asked for. A deployment that needs more than serial transcription has
	 * outgrown an in-process worker; the back-fill widens the recovery path, not this loop.
	 */
	private async drain(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			for (;;) {
				const job = this.queue.shift();
				if (job === undefined || this.stopped) {
					return;
				}
				// `transcribeNow` never throws; the guard is here for a defect rather than a failure.
				try {
					await this.transcribeNow(job.organizationId, job.messageId);
				} catch (error) {
					this.failed += 1;
					logger.error(
						{ ...job, err: error },
						"the transcription worker threw; the message keeps whatever status it had",
					);
				} finally {
					this.held.delete(job.messageId);
				}
				if (job.deferredEmail) {
					// After the row is written and outside the try above, so a notification is never sent
					// on the strength of a transcript the database rejected. Awaited rather than
					// fire-and-forget: the worker is already off the consumer's path, and letting the mail
					// overlap the next transcription would put two providers' latencies in one heap
					// profile for no gain. `settleEmail` never throws.
					await this.settleEmail(job.organizationId, job.mailboxId, job.messageId, "settled");
				}
			}
		} finally {
			this.draining = false;
		}
	}

	/**
	 * Transcribes one message and records the result. Never throws.
	 *
	 * Public and awaitable because it is the unit worth testing and the unit the back-fill's reclaimed
	 * rows travel through; {@link enqueue} is the fire-and-forget wrapper the consumer
	 * uses. Every refusal is a named outcome, because "why does this message have no transcript" is
	 * a question an operator asks about one specific message and a boolean cannot answer.
	 */
	async transcribeNow(
		organizationId: string,
		messageId: string,
	): Promise<VoicemailTranscriptionOutcome> {
		if (!this.provider.enabled) {
			this.skipped += 1;
			return { outcome: "skipped", reason: "provider-disabled" };
		}

		const row = await this.readPendingMessage(organizationId, messageId);
		if (row === undefined) {
			this.skipped += 1;
			return { outcome: "skipped", reason: "no-such-message" };
		}
		if (row.transcriptionStatus !== "pending") {
			// A redelivery whose message is already transcribed, or one an operator has retried by
			// hand. Not an error; doing nothing is the whole correct behaviour.
			this.skipped += 1;
			return { outcome: "skipped", reason: "not-pending" };
		}

		const audio = this.audioFor(row.objectKey, row.sizeBytes);
		const result = await this.attempt(audio, organizationId, messageId);

		if (result.kind === "audio-missing") {
			// The object has been reaped or was never written. Permanent, and recorded as `failed`
			// rather than left `pending`: a back-fill that retried it would fail the same way forever.
			await this.markFailed(organizationId, messageId);
			this.skipped += 1;
			return { outcome: "skipped", reason: "audio-missing" };
		}
		if (result.kind === "failed") {
			await this.markFailed(organizationId, messageId);
			this.failed += 1;
			return { outcome: "failed", attempts: result.attempts };
		}

		await this.markDone(organizationId, messageId, result.text);
		this.transcribed += 1;
		return { outcome: "done", characters: result.text.length, attempts: result.attempts };
	}

	/**
	 * The retry policy: bounded attempts, exponential backoff, and a hard stop on a permanent error.
	 *
	 * `TRANSCRIBE_MAX_ATTEMPTS` attempts in total (3 by default), waiting
	 * `TRANSCRIBE_RETRY_BASE_MS * 2^(n-1)` between them and capped at `TRANSCRIBE_MAX_BACKOFF_MS` —
	 * 2s then 4s on the defaults, so a message that is going to fail has done so within about six
	 * seconds of provider latency rather than occupying the worker for a minute.
	 *
	 * The bound is small on purpose. What retrying absorbs is a TRANSIENT — a 429, a cold local
	 * server, a reset connection — and a provider that is genuinely down stays down for far longer
	 * than any budget worth spending on a derived artifact. The row is marked `failed`, which is a
	 * state the partial index makes cheap to sweep, and a back-fill can retry the whole cohort once
	 * somebody has fixed the endpoint. That is a better shape than this process retrying forever and
	 * a much better shape than it retrying forever while holding the queue.
	 *
	 * A failure whose driver said `retryable: false` — a 401, a 404 from a base URL missing its
	 * `/v1`, a model the endpoint does not have, an object over the size cap — stops IMMEDIATELY.
	 * Those are configuration, and the retry loop is not going to fix somebody's API key.
	 */
	private async attempt(
		audio: TranscriptionAudio,
		organizationId: string,
		messageId: string,
	): Promise<
		| { readonly kind: "done"; readonly text: string; readonly attempts: number }
		| { readonly kind: "failed"; readonly attempts: number }
		| { readonly kind: "audio-missing" }
	> {
		for (let attempt = 1; attempt <= this.settings.maxAttempts; attempt += 1) {
			try {
				const result = await this.provider.transcribe(audio);
				return { kind: "done", text: result.text, attempts: attempt };
			} catch (error) {
				if (error instanceof ObjectNotFoundError) {
					logger.warn(
						{ organizationId, messageId, objectKey: audio.objectKey },
						"a voicemail is marked for transcription but its audio is not in the store",
					);
					return { kind: "audio-missing" };
				}

				const retryable = isRetryableFailure(error);
				const last = attempt >= this.settings.maxAttempts;
				logger[retryable && !last ? "warn" : "error"](
					{
						organizationId,
						messageId,
						attempt,
						maxAttempts: this.settings.maxAttempts,
						retryable,
						err: error,
					},
					"a voicemail transcription attempt failed",
				);
				if (!retryable || last || this.stopped) {
					return { kind: "failed", attempts: attempt };
				}
				await sleep(this.backoffFor(attempt));
			}
		}
		// Unreachable: the loop returns on the last attempt. Kept so the signature needs no assertion.
		return { kind: "failed", attempts: this.settings.maxAttempts };
	}

	/** `base * 2^(n-1)`, capped. Zero base means zero wait, which is what the tests configure. */
	private backoffFor(attempt: number): number {
		const raw = this.settings.retryBaseMs * 2 ** (attempt - 1);
		return Math.min(raw, this.settings.maxBackoffMs);
	}

	/**
	 * Binds one message's audio to a closure the provider can open, and nothing else.
	 *
	 * `open` is re-callable, which is what makes the retry above sound: a port that took a
	 * `Readable` would hand the second attempt an exhausted stream. See
	 * `src/transcription/transcription-provider.ts`.
	 */
	private audioFor(objectKey: string, sizeBytes: number | null): TranscriptionAudio {
		const store = this.store;
		return {
			objectKey,
			sizeBytes: sizeBytes ?? undefined,
			contentType: contentTypeFor(objectKey),
			languageHint: undefined,
			async open() {
				return await store.getStream(objectKey);
			},
		};
	}

	/**
	 * Reads the row this is about to work on, under the tenant's own scope.
	 *
	 * The status is read here as well as the key, so a duplicate enqueue — which a JetStream
	 * redelivery produces for free — costs one query rather than a transcription.
	 */
	private async readPendingMessage(
		organizationId: string,
		messageId: string,
	): Promise<PendingMessageRow | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({
					objectKey: voicemailMessage.objectKey,
					sizeBytes: voicemailMessage.sizeBytes,
					transcriptionStatus: voicemailMessage.transcriptionStatus,
				})
				.from(voicemailMessage)
				.where(eq(voicemailMessage.id, messageId))
				.limit(1);
			return rows[0];
		});
	}

	/**
	 * Writes the transcript.
	 *
	 * Guarded on `transcription_status = 'pending'` in the UPDATE's own predicate rather than on the
	 * read above, so two workers racing the same message — which a hand-run back-fill alongside the
	 * live worker would produce — cannot both write. The loser updates zero rows and says so.
	 */
	private async markDone(organizationId: string, messageId: string, text: string): Promise<void> {
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await transaction
				.update(voicemailMessage)
				.set({
					transcription: text,
					transcriptionStatus: "done",
					transcribedAt: new Date(),
				})
				.where(
					and(
						eq(voicemailMessage.id, messageId),
						eq(voicemailMessage.transcriptionStatus, "pending"),
					),
				);
		});
	}

	/**
	 * Records that this one is not going to transcribe.
	 *
	 * `transcription` is left ALONE rather than set to null: on the ordinary path it is already
	 * null, and on the path where a back-fill is re-running a message that once succeeded, erasing a
	 * transcript somebody has already read because a second attempt hit a 500 is a strictly worse
	 * outcome than keeping it beside a `failed` status.
	 */
	private async markFailed(organizationId: string, messageId: string): Promise<void> {
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await transaction
				.update(voicemailMessage)
				.set({ transcriptionStatus: "failed" })
				.where(
					and(
						eq(voicemailMessage.id, messageId),
						eq(voicemailMessage.transcriptionStatus, "pending"),
					),
				);
		});
	}

	// -------------------------------------------------------------------------------------------
	// The deferred notification
	// -------------------------------------------------------------------------------------------

	/**
	 * Starts the clock on a notification that is waiting for a transcript.
	 *
	 * `TRANSCRIBE_EMAIL_WAIT_MS` is a BUDGET, not a delay: the ordinary path never reaches the timer
	 * because the worker settles first and cancels it. What it bounds is every way a transcription
	 * can fail to settle at all — a provider hanging past its own timeout, a queue that refused the
	 * job, a worker wedged on the message in front. The alternative to a budget is a notification
	 * whose arrival time is a provider's availability, which is not a property anybody wants their
	 * voicemail alerts to have.
	 *
	 * `unref` so a pending budget cannot hold the process open; a container that is otherwise
	 * finished must exit, and the row it leaves behind is one the back-fill reclaims.
	 */
	private armEmailBudget(organizationId: string, mailboxId: string, messageId: string): void {
		if (this.emailTimers.has(messageId)) {
			return;
		}
		this.deferredEmails += 1;
		const timer = setTimeout(() => {
			this.timedOutEmails += 1;
			void this.settleEmail(organizationId, mailboxId, messageId, "budget-expired");
		}, this.settings.emailWaitMs);
		timer.unref?.();
		this.emailTimers.set(messageId, timer);
	}

	/**
	 * Sends the deferred notification, whichever path got here first. Never throws.
	 *
	 * There is no check for "has the worker finished" and there deliberately is not one: the worker,
	 * the budget timer and the back-fill can all reach this for the same message, and an in-memory
	 * flag would be right in one process and wrong across two. The once-only guarantee lives in the
	 * database — `VoicemailEmailService` claims `email_sent_at` immediately before the relay call —
	 * so the loser here is one refused UPDATE and a `skipped: already-sent` outcome.
	 *
	 * What the caller DOES decide is the transcript: `notify` reads the row, so a settlement that ran
	 * after a `done` carries the text and one that ran after a `failed` or a still-`pending` row
	 * carries the unavailable marker. That decision is made from the row rather than from an argument
	 * for the same reason — the row is the thing all three callers agree about.
	 */
	private async settleEmail(
		organizationId: string,
		mailboxId: string,
		messageId: string,
		reason: "settled" | "budget-expired",
	): Promise<void> {
		const timer = this.emailTimers.get(messageId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.emailTimers.delete(messageId);
		}
		const outcome = await this.email.notify(organizationId, mailboxId, messageId);
		if (outcome.outcome === "failed") {
			logger.warn(
				{ organizationId, mailboxId, messageId, reason },
				"a deferred voicemail notification could not be sent",
			);
		}
	}
}

interface PendingMessageRow {
	readonly objectKey: string;
	readonly sizeBytes: number | null;
	readonly transcriptionStatus: string;
}

/**
 * Whether the pipeline should try again.
 *
 * Only a {@link import("../../transcription").TranscriptionFailure} carries the answer, and
 * anything else that escaped a driver is a DEFECT rather than a transient — a `TypeError` in a
 * response parser is not going to parse differently in four seconds. Treating an unclassified throw
 * as permanent is what stops a driver bug from becoming a retry loop.
 *
 * Matched structurally on `_tag` rather than with `instanceof`, on the same terms as the rest of
 * this app's tagged errors: an `instanceof` across a module boundary is one duplicated copy of a
 * package away from being false, and this decision is not worth that failure mode.
 */
function isRetryableFailure(error: unknown): boolean {
	if (error === null || typeof error !== "object") {
		return false;
	}
	const tagged = error as { _tag?: unknown; retryable?: unknown };
	return tagged._tag === "TranscriptionFailure" && tagged.retryable === true;
}

/** Content type from the object key's extension. WAV is what the engine writes today. */
function contentTypeFor(objectKey: string): string {
	const lower = objectKey.toLowerCase();
	if (lower.endsWith(".mp3")) {
		return "audio/mpeg";
	}
	if (lower.endsWith(".ogg") || lower.endsWith(".opus")) {
		return "audio/ogg";
	}
	return "audio/wav";
}

/** A zero-millisecond wait still yields the loop, which is what the tests rely on. */
async function sleep(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}
