import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_DATABASE, PBX_TRANSCRIPTION_SETTINGS } from "../shared/pbx.tokens";
import { claimTranscriptionBacklog } from "./voicemail-transcription-backfill";
import { VoicemailTranscriptionService } from "./voicemail-transcription.service";
import type { TranscriptionEnv } from "../../transcription";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The transcription back-fill: the second half of the safety net, and the half that runs when the
 * first one did not.
 *
 * ## The ordering it depends on, stated once
 *
 * ```
 *  in the filing transaction   INSERT the message with transcription_status = 'pending'
 *  after the ack               enqueue it on the in-memory worker           (fast path)
 *  every TRANSCRIBE_SWEEP_INTERVAL_MS   claim whatever is still owed        (this file)
 * ```
 *
 * The fast path is not a duplicate of this and is not going away — it is what makes a transcript
 * arrive in seconds, and it handles every message on a healthy process. This exists for exactly the
 * cases it structurally cannot cover, all of which `voicemail-transcription.service.ts` names in its
 * own header as things that leave a row `pending`:
 *
 * - **the queue overflowed** — `enqueue` refuses past `TRANSCRIBE_QUEUE_LIMIT` and deliberately
 *   leaves the row `pending` rather than `failed`, because "nobody got to it" and "a provider
 *   refused it" are different facts;
 * - **the process died or was deployed** — `onApplicationShutdown` drops the backlog on purpose
 *   rather than blocking a deploy on a slow provider;
 * - **the provider was down** — those rows are `failed`, and a `failed` cohort is precisely what an
 *   operator who has just fixed an endpoint wants retried.
 *
 * Before this existed, all three were a permanent gap: the four-state column and the partial index
 * were built for a sweep that nothing ran.
 *
 * ## This IS a queue consumer, unlike the projection outbox's sweeper
 *
 * `projection-outbox.service.ts` argues at length for having no lease and no worker id, and it is
 * right THERE for a reason that does not transfer: every publish it makes is an idempotent
 * whole-organization reconcile, so two replicas doing the same work write the same bytes. A
 * transcription is not idempotent in the way that matters — the second one is a second paid request
 * to somebody's speech-to-text endpoint and a second few megabytes on the heap — so this one claims.
 *
 * The claim is a committed compare-and-set rather than a held lock;
 * `voicemail-transcription-backfill.ts` is where that decision is argued. Three guards stack, and
 * none is sufficient alone:
 *
 * 1. **the grace window** — a `pending` row younger than `TRANSCRIBE_SWEEP_GRACE_MS` is presumed to
 *    be in some process's live queue;
 * 2. **the held set** — the ids THIS process is working on are excluded by id, which is exact;
 * 3. **the claim column** — another replica's claim is visible to this one, which is the only guard
 *    that crosses a process boundary.
 *
 * And underneath all three, `markDone` and `markFailed` are guarded on `transcription_status =
 * 'pending'`, so even a genuine double-transcription writes exactly one result.
 *
 * ## Reclaimed rows go through the SAME worker
 *
 * A claim ends in {@link VoicemailTranscriptionService.enqueue}, not in a second transcription
 * implementation. The retry policy, the tenant-scoped key read, the object-missing handling and the
 * status writes are the pipeline's, and a back-fill that reimplemented any of them would be a second
 * place for the rule "this may never cost a message" to be got wrong. The consequence is that a
 * sweep RETURNS before its work finishes, which is why {@link VoicemailBacklogSweepResult} counts
 * claims rather than transcripts.
 */
@Injectable()
export class VoicemailTranscriptionSweeper implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private swept = 0;
	private claimed = 0;
	private terminal = 0;
	private failed = 0;

	/**
	 * Tokens spelled out for every parameter, including the plain class.
	 *
	 * The area runs under `tsx`/esbuild, which does not emit `design:paramtypes`, so Nest has no type
	 * metadata to resolve a bare class parameter from and injects `undefined` — a `TypeError` on
	 * first use rather than a wiring error at boot. `ProjectionOutboxSweeper` records the same reason.
	 */
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(PBX_TRANSCRIPTION_SETTINGS) private readonly settings: TranscriptionEnv,
		@Inject(VoicemailTranscriptionService)
		private readonly transcription: VoicemailTranscriptionService,
	) {}

	get stats(): {
		readonly swept: number;
		readonly claimed: number;
		readonly terminal: number;
		readonly failed: number;
	} {
		return {
			swept: this.swept,
			claimed: this.claimed,
			terminal: this.terminal,
			failed: this.failed,
		};
	}

	onModuleInit(): void {
		if (!this.transcription.enabled) {
			// Nothing marks a row `pending` without a provider (`VoicemailConsumer.file`), so a timer
			// here would poll for a backlog that cannot grow. Rows left `pending` by a deployment that
			// has since turned transcription OFF are deliberately left alone rather than swept into
			// `failed`: turning the feature back on is what should pick them up.
			return;
		}
		if (this.settings.sweepIntervalMs === 0) {
			logger.warn(
				"TRANSCRIBE_SWEEP_INTERVAL_MS is 0 — voicemail transcriptions are recorded but never " +
					"backed off this process. A message left `pending` by a restart or a full queue stays " +
					"pending until another process sweeps.",
			);
			return;
		}
		// `unref` so a pending timer cannot hold open a process that is otherwise finished — a
		// verification script that boots the module and exits must exit.
		this.timer = setInterval(() => {
			void this.sweep();
		}, this.settings.sweepIntervalMs);
		this.timer.unref?.();
		logger.info(
			{
				intervalMs: this.settings.sweepIntervalMs,
				graceMs: this.settings.sweepGraceMs,
				retryAfterMs: this.settings.sweepRetryAfterMs,
				maxAttempts: this.settings.sweepMaxAttempts,
			},
			"voicemail transcription back-fill started",
		);
	}

	onApplicationShutdown(): void {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * One pass. Public so a harness can drive it deterministically instead of waiting out an interval,
	 * which is the only honest way to test a timer.
	 *
	 * Re-entrancy is refused rather than queued, on the same terms as the projection outbox's sweep: a
	 * pass that is still claiming when the next tick fires is already behind, and a second one would
	 * only compete with it for the same rows.
	 */
	async sweep(): Promise<VoicemailBacklogSweepResult> {
		if (this.running || this.stopped || !this.transcription.enabled) {
			return { claimed: 0, terminal: 0 };
		}
		this.running = true;
		try {
			return await this.runOnce();
		} catch (error) {
			// A sweep that throws must not kill the interval. The next tick tries again, and the rows it
			// failed to claim are still `pending` — which is the whole reason this design puts the queue
			// in the row.
			this.failed += 1;
			logger.error({ err: error }, "the voicemail transcription back-fill failed");
			return { claimed: 0, terminal: 0 };
		} finally {
			this.running = false;
		}
	}

	private async runOnce(): Promise<VoicemailBacklogSweepResult> {
		const claimed = await claimTranscriptionBacklog(
			this.database.adminDb,
			new Date(),
			{
				graceMs: this.settings.sweepGraceMs,
				retryAfterMs: this.settings.sweepRetryAfterMs,
				claimTtlMs: this.settings.sweepClaimTtlMs,
				maxAttempts: this.settings.sweepMaxAttempts,
				batch: this.settings.sweepBatch,
			},
			this.transcription.heldMessageIds(),
		);
		this.swept += 1;
		if (claimed.length === 0) {
			return { claimed: 0, terminal: 0 };
		}

		let terminal = 0;
		for (const message of claimed) {
			if (this.stopped) {
				break;
			}
			if (message.attempts >= this.settings.sweepMaxAttempts) {
				// The LAST attempt this message will ever get. Said once, at the moment it is spent,
				// rather than on every pass afterwards: past the ceiling the row is simply not eligible,
				// so there is no later pass to say it again and no repeating log to bury it in.
				terminal += 1;
				logger.warn(
					{
						organizationId: message.organizationId,
						messageId: message.messageId,
						attempts: message.attempts,
						maxAttempts: this.settings.sweepMaxAttempts,
					},
					"a voicemail is on its final transcription attempt; after this, `failed` is terminal",
				);
			}
			// The same entry point the consumer uses, with the same refusals. The notification is
			// deferred only when this message still owes one — a row that was emailed at filing time
			// (the organization did not ask for the transcript in the mail) must not arm a budget whose
			// only possible outcome is a refused compare-and-set.
			this.transcription.enqueue(message.organizationId, message.mailboxId, message.messageId, {
				deferredEmail: !message.emailed,
			});
		}

		this.claimed += claimed.length;
		this.terminal += terminal;
		logger.info(
			{ claimed: claimed.length, terminal },
			"the voicemail transcription back-fill reclaimed messages the live queue did not finish",
		);
		return { claimed: claimed.length, terminal };
	}
}

export interface VoicemailBacklogSweepResult {
	/** Rows this pass took responsibility for. Not transcripts: the worker finishes after the sweep. */
	readonly claimed: number;
	/** Of those, the ones now on their final attempt. */
	readonly terminal: number;
}
