import { Readable } from "node:stream";
import { expect } from "chai";
import { isMessageRead } from "../../src/pbx/voicemail-boxes/voicemail-messages.dto";
import { VoicemailMessagesService } from "../../src/pbx/voicemail-boxes/voicemail-messages.service";
import { VoicemailTranscriptionService } from "../../src/pbx/voicemail-boxes/voicemail-transcription.service";
import { ObjectNotFoundError } from "../../src/storage";
import { loadTranscriptionEnv, TranscriptionFailure } from "../../src/transcription";
import type { VoicemailEmailService } from "../../src/pbx/voicemail-boxes/voicemail-email.service";
import type { ObjectStore } from "../../src/storage";
import type {
	TranscriptionAudio,
	TranscriptionEnv,
	TranscriptionProvider,
	TranscriptionResult,
} from "../../src/transcription";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The transcription PIPELINE — everything between a filed row and a transcript.
 *
 * The seam itself (drivers, environment, failure classification) is
 * `test/transcription/transcriptionProvider.test.ts`. What this file is about is the rule that
 * governs the pipeline and only the pipeline:
 *
 * > **This may never cost a message.**
 *
 * A voicemail is a customer talking to a business; a transcript is a convenience on top of it. So
 * the assertions that matter here are negative ones — what the pipeline does NOT do when a provider
 * fails. It must not touch the message row's own columns, must not move a folder, must not publish
 * an MWI event, and must not throw into the caller that filed the row. Those are asserted directly
 * (`writes`, below, records every column the service ever `set`) rather than inferred from a happy
 * path, because a regression here is silent: the transcript is missing either way, and the
 * difference between "missing transcript" and "lost voicemail" only shows up in the columns.
 *
 * The database is faked rather than stubbed per-query, on the same terms as
 * `auditLogQuery.test.ts`: asserting on the SQL would be asserting on Drizzle. What the fake
 * records is what the SERVICE decides — which organization the transaction is opened for, and which
 * columns it wrote.
 */

const ORGANIZATION_ID = "00000000-0000-7000-8000-0000000000a1";
const OTHER_ORGANIZATION_ID = "00000000-0000-7000-8000-0000000000b2";
const MAILBOX_ID = "00000000-0000-7000-8000-0000000000c3";
const MESSAGE_ID = "00000000-0000-7000-8000-0000000000d4";
const OBJECT_KEY = `${ORGANIZATION_ID}/${MESSAGE_ID}.wav`;

/** Zero backoff, so the retry loop runs at test speed without a clock seam. */
const FAST_RETRIES = {
	TRANSCRIBE_BASE_URL: "https://api.example.test/v1",
	TRANSCRIBE_MODEL: "whisper-1",
	TRANSCRIBE_RETRY_BASE_MS: "0",
	TRANSCRIBE_MAX_BACKOFF_MS: "0",
} satisfies NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------------------------
// 1. Disabled is the default, and it costs nothing
// ---------------------------------------------------------------------------------------------

describe("voicemail transcription when the provider is disabled", () => {
	it("reports itself disabled, which is what the consumer keys the row's status off", () => {
		const { service } = harness({ provider: disabledProvider() });
		expect(service.enabled).to.equal(false);
	});

	it("skips without opening a transaction or an object", async () => {
		// The whole point of the default: no database round trip, no object read, no allocation.
		const { service, scopes, opens } = harness({ provider: disabledProvider() });

		const outcome = await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(outcome).to.deep.equal({ outcome: "skipped", reason: "provider-disabled" });
		expect(scopes).to.deep.equal([]);
		expect(opens).to.equal(0);
	});

	it("enqueues nothing, so a disabled deployment never grows a queue", () => {
		const { service } = harness({ provider: disabledProvider() });
		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);
		expect(service.stats.queued).to.equal(0);
		expect(service.stats.dropped).to.equal(0);
	});
});

// ---------------------------------------------------------------------------------------------
// 2. The happy path
// ---------------------------------------------------------------------------------------------

describe("voicemail transcription when a provider answers", () => {
	it("writes the transcript, the status and the timestamp, and nothing else", async () => {
		const { service, writes } = harness({ provider: answering("call me back on Tuesday") });

		const outcome = await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(outcome).to.deep.include({ outcome: "done", attempts: 1 });
		expect(writes).to.have.length(1);
		const write = writes[0] as Record<string, unknown>;
		expect(write.transcription).to.equal("call me back on Tuesday");
		expect(write.transcriptionStatus).to.equal("done");
		expect(write.transcribedAt).to.be.instanceOf(Date);
		// The message's OWN columns are untouched. A pipeline that could write `folder` here is one
		// bad merge away from moving somebody's voicemail out of their inbox.
		expect(Object.keys(write).sort()).to.deep.equal([
			"transcribedAt",
			"transcription",
			"transcriptionStatus",
		]);
	});

	it("records an EMPTY transcript as done, because silence is an answer", async () => {
		// `done` with an empty string is a real result, and it is why the status column exists: a UI
		// keyed on the text alone would render it identically to "nobody tried".
		const { service, writes } = harness({ provider: answering("") });

		const outcome = await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(outcome).to.deep.include({ outcome: "done", characters: 0 });
		expect((writes[0] as Record<string, unknown>).transcriptionStatus).to.equal("done");
	});

	it("opens the audio through the store using the key from the ROW, not from a caller", async () => {
		// The tenancy argument: the key is re-read inside `withTenantScope`, so RLS has proved the
		// message belongs to this organization before a byte of audio is opened. A pipeline that took
		// the key off the NATS envelope would work identically here and would let a mis-subjected
		// event point this process at another tenant's object.
		const { service, opened } = harness({ provider: answering("x") });

		await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(opened).to.deep.equal([OBJECT_KEY]);
	});

	it("hands the provider a closure and never an object store", async () => {
		let received: TranscriptionAudio | undefined;
		const { service } = harness({
			provider: {
				driver: "openai-compatible",
				enabled: true,
				async transcribe(audio) {
					received = audio;
					return { text: "x" };
				},
			},
		});

		await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(received?.objectKey).to.equal(OBJECT_KEY);
		expect(received?.contentType).to.equal("audio/wav");
		expect(typeof received?.open).to.equal("function");
		// Nothing on the request can reach another object.
		expect(Object.keys(received ?? {})).to.not.include("store");
	});

	it("opens every transaction for the organization it was given and no other", async () => {
		const { service, scopes } = harness({ provider: answering("x") });

		await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(new Set(scopes)).to.deep.equal(new Set([ORGANIZATION_ID]));
		expect(scopes).to.not.contain(OTHER_ORGANIZATION_ID);
	});
});

// ---------------------------------------------------------------------------------------------
// 3. Failure — the section this file exists for
// ---------------------------------------------------------------------------------------------

describe("voicemail transcription when a provider fails", () => {
	it("retries a transient failure up to the budget, then marks the row failed", async () => {
		const provider = failing({ retryable: true });
		const { service, writes } = harness({ provider, env: { ...FAST_RETRIES } });

		const outcome = await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		// Three attempts, which is `TRANSCRIBE_MAX_ATTEMPTS`'s default.
		expect(provider.calls).to.equal(3);
		expect(outcome).to.deep.equal({ outcome: "failed", attempts: 3 });
		expect(writes).to.have.length(1);
		expect(writes[0]).to.deep.equal({ transcriptionStatus: "failed" });
	});

	it("honours a smaller retry budget", async () => {
		const provider = failing({ retryable: true });
		const { service } = harness({
			provider,
			env: { ...FAST_RETRIES, TRANSCRIBE_MAX_ATTEMPTS: "1" },
		});

		await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(provider.calls).to.equal(1);
	});

	it("stops immediately on a permanent failure, because a retry will not fix an API key", async () => {
		const provider = failing({ retryable: false });
		const { service, writes } = harness({ provider, env: { ...FAST_RETRIES } });

		const outcome = await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(provider.calls).to.equal(1);
		expect(outcome).to.deep.equal({ outcome: "failed", attempts: 1 });
		expect(writes[0]).to.deep.equal({ transcriptionStatus: "failed" });
	});

	it("treats an UNCLASSIFIED throw as permanent, so a driver bug is not a spin", async () => {
		// A `TypeError` in a response parser is a defect, and it is not going to parse differently in
		// four seconds. Retrying it forever is how one bad driver takes the worker with it.
		let calls = 0;
		const { service, writes } = harness({
			env: { ...FAST_RETRIES },
			provider: {
				driver: "openai-compatible",
				enabled: true,
				async transcribe() {
					calls += 1;
					throw new TypeError("cannot read property 'text' of undefined");
				},
			},
		});

		const outcome = await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(calls).to.equal(1);
		expect(outcome).to.deep.equal({ outcome: "failed", attempts: 1 });
		expect(writes[0]).to.deep.equal({ transcriptionStatus: "failed" });
	});

	it("never throws into its caller, whatever the provider did", async () => {
		// `transcribeNow` is called from a worker loop that must keep draining, and `enqueue` is
		// called from the JetStream consumer after the ack. A throw escaping here would reach a
		// `catch` that NAKs — and the delivery it would NAK has already been acked.
		const { service } = harness({
			env: { ...FAST_RETRIES },
			provider: failing({ retryable: false }),
		});
		const outcome = await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);
		expect(outcome.outcome).to.equal("failed");
	});

	it("never writes the message's own columns on the failure path", async () => {
		const { service, writes } = harness({
			env: { ...FAST_RETRIES },
			provider: failing({ retryable: true }),
		});

		await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		for (const write of writes) {
			expect(Object.keys(write)).to.deep.equal(["transcriptionStatus"]);
		}
	});

	it("leaves an existing transcript alone when a later attempt fails", async () => {
		// A back-fill re-running a message that once succeeded must not erase a transcript somebody
		// has already read just because the second attempt hit a 500.
		const { service, writes } = harness({
			env: { ...FAST_RETRIES },
			provider: failing({ retryable: false }),
		});

		await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(Object.keys(writes[0] as object)).to.not.include("transcription");
	});

	it("marks a message whose audio has been reaped as failed, not left pending forever", async () => {
		const { service, writes } = harness({
			provider: answering("unreachable"),
			store: missingObjectStore(),
		});

		const outcome = await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(outcome).to.deep.equal({ outcome: "skipped", reason: "audio-missing" });
		expect(writes[0]).to.deep.equal({ transcriptionStatus: "failed" });
	});
});

// ---------------------------------------------------------------------------------------------
// 4. Rows the pipeline should leave alone
// ---------------------------------------------------------------------------------------------

describe("voicemail transcription and the row's status", () => {
	it("does nothing for a message that is already done", async () => {
		// A JetStream redelivery produces a duplicate enqueue for free; it must cost one query, not a
		// transcription and certainly not an overwrite.
		const provider = answering("would be wrong");
		const { service, writes } = harness({ provider, row: { transcriptionStatus: "done" } });

		const outcome = await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(outcome).to.deep.equal({ outcome: "skipped", reason: "not-pending" });
		expect(writes).to.deep.equal([]);
	});

	it("does nothing for a message marked disabled", async () => {
		const { service, writes } = harness({
			provider: answering("x"),
			row: { transcriptionStatus: "disabled" },
		});

		const outcome = await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(outcome).to.deep.equal({ outcome: "skipped", reason: "not-pending" });
		expect(writes).to.deep.equal([]);
	});

	it("does nothing for a message that has been purged since it was queued", async () => {
		const { service, writes } = harness({ provider: answering("x"), row: undefined });

		const outcome = await service.transcribeNow(ORGANIZATION_ID, MESSAGE_ID);

		expect(outcome).to.deep.equal({ outcome: "skipped", reason: "no-such-message" });
		expect(writes).to.deep.equal([]);
	});
});

// ---------------------------------------------------------------------------------------------
// 5. The queue
// ---------------------------------------------------------------------------------------------

describe("the transcription queue", () => {
	it("drains what it is given without the caller awaiting anything", async () => {
		const { service, writes } = harness({ provider: answering("drained") });

		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);
		await settle();

		expect(writes).to.have.length(1);
		expect(service.stats.transcribed).to.equal(1);
		expect(service.stats.queued).to.equal(0);
	});

	it("refuses past the ceiling and leaves those rows PENDING rather than failed", async () => {
		// "Nobody got to it" and "a provider rejected it" are different facts, and an operator
		// restarting a wedged provider wants only the first set retried. A dropped job therefore
		// writes nothing at all — the row keeps the `pending` the insert gave it.
		const gate = blockingProvider();
		const { service, writes } = harness({
			provider: gate.provider,
			env: { ...FAST_RETRIES, TRANSCRIBE_QUEUE_LIMIT: "1" },
		});

		// The first is picked up by the worker and blocks; the second fills the queue; the third is
		// refused.
		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);
		await settle();
		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);
		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(service.stats.dropped).to.equal(1);
		expect(writes).to.deep.equal([]);
		gate.release();
		await settle();
	});

	it("stops accepting and drops the backlog on shutdown, leaving those rows pending", async () => {
		// Blocking a deploy on a provider that is already slow is how a container gets stuck. The
		// abandoned rows are `pending`, which is the state the partial index makes cheap to sweep.
		const { service, writes } = harness({ provider: answering("x") });

		await service.onApplicationShutdown();
		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);
		await settle();

		expect(service.stats.queued).to.equal(0);
		expect(writes).to.deep.equal([]);
	});

	it("counts what it did, so an operator can see the feature working", async () => {
		const { service } = harness({ provider: answering("x") });

		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);
		await settle();

		expect(service.stats).to.deep.include({ enabled: true, transcribed: 1, failed: 0 });
	});
});

// ---------------------------------------------------------------------------------------------
// 6. The read surface
// ---------------------------------------------------------------------------------------------

/**
 * What the messages endpoint puts on the wire.
 *
 * The three fields travel TOGETHER or the status is decoration: a client that received
 * `transcription: null` with no status cannot tell "nobody tried" from "a spinner belongs here"
 * from "a provider refused", and those are three different screens.
 */
describe("the voicemail message read model", () => {
	it("carries the transcript, the status and the timestamp on a listed message", async () => {
		const { service } = messagesHarness({
			transcription: "please call back",
			transcriptionStatus: "done",
			transcribedAt: new Date("2026-08-11T17:03:40.000Z"),
		});

		const envelope = await service.list(session(), MAILBOX_ID, { page: 1, limit: 25 });

		const row = envelope.data[0];
		expect(row?.transcription).to.equal("please call back");
		expect(row?.transcriptionStatus).to.equal("done");
		expect(row?.transcribedAt).to.equal("2026-08-11T17:03:40.000Z");
	});

	it("sends `disabled` with nulls when the feature is off, rather than omitting the fields", async () => {
		// Omitting them would make an off deployment's payload structurally different from an on
		// one's, which is how a client ends up with `undefined` where it expected a discriminant.
		const { service } = messagesHarness({
			transcription: null,
			transcriptionStatus: "disabled",
			transcribedAt: null,
		});

		const row = (await service.list(session(), MAILBOX_ID, { page: 1, limit: 25 })).data[0];

		expect(row?.transcription).to.equal(null);
		expect(row?.transcriptionStatus).to.equal("disabled");
		expect(row?.transcribedAt).to.equal(null);
	});

	it("sends `pending` with a null transcript and a null timestamp", async () => {
		const { service } = messagesHarness({
			transcription: null,
			transcriptionStatus: "pending",
			transcribedAt: null,
		});

		const row = (await service.list(session(), MAILBOX_ID, { page: 1, limit: 25 })).data[0];

		expect(row?.transcriptionStatus).to.equal("pending");
		expect(row?.transcribedAt).to.equal(null);
	});

	it("sends `failed` and keeps the rest of the message intact", async () => {
		const { service } = messagesHarness({
			transcription: null,
			transcriptionStatus: "failed",
			transcribedAt: null,
		});

		const row = (await service.list(session(), MAILBOX_ID, { page: 1, limit: 25 })).data[0];

		expect(row?.transcriptionStatus).to.equal("failed");
		// Everything the endpoint answered before this feature existed still answers.
		expect(row?.id).to.equal(MESSAGE_ID);
		expect(row?.durationMs).to.equal(4_200);
		expect(row?.read).to.equal(isMessageRead("new"));
	});
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface PendingRow {
	readonly objectKey?: string;
	readonly sizeBytes?: number | null;
	readonly transcriptionStatus?: string;
}

interface Harness {
	readonly service: VoicemailTranscriptionService;
	/** Every organization a transaction was opened for. */
	readonly scopes: string[];
	/** Every column set the service ever wrote — the negative assertions live on this. */
	readonly writes: Record<string, unknown>[];
	/** Every object key opened through the store. */
	readonly opened: string[];
	readonly opens: number;
	/** Every message id the pipeline asked the email service to notify about. */
	readonly notified: string[];
}

function harness(options: {
	readonly provider: TranscriptionProvider;
	readonly env?: NodeJS.ProcessEnv;
	readonly row?: PendingRow | undefined;
	readonly store?: ObjectStore;
}): Harness {
	const scopes: string[] = [];
	const writes: Record<string, unknown>[] = [];
	const opened: string[] = [];
	const hasRow = !("row" in options) || options.row !== undefined;
	const row = {
		objectKey: options.row?.objectKey ?? OBJECT_KEY,
		sizeBytes: options.row?.sizeBytes ?? 12,
		transcriptionStatus: options.row?.transcriptionStatus ?? "pending",
	};

	const transaction = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => (hasRow ? [row] : []),
				}),
			}),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					writes.push(values);
				},
			}),
		}),
	};

	const database = {
		withTenantScope: async <T>(
			organizationId: string,
			work: (transaction: never) => Promise<T>,
		): Promise<T> => {
			scopes.push(organizationId);
			return await work(transaction as never);
		},
	} as unknown as PbxDatabaseClient;

	const store =
		options.store ??
		({
			driver: "local",
			async getStream(objectKey: string) {
				opened.push(objectKey);
				return Readable.from([Buffer.from("RIFF....WAVE")]);
			},
		} as unknown as ObjectStore);

	const settings: TranscriptionEnv = loadTranscriptionEnv(options.env ?? { ...FAST_RETRIES });
	const notified: string[] = [];
	const email = {
		async notify(_organizationId: string, _mailboxId: string, messageId: string) {
			notified.push(messageId);
			return { outcome: "sent", to: "box@example.test", linked: false };
		},
	} as unknown as VoicemailEmailService;
	const service = new VoicemailTranscriptionService(
		database,
		store,
		options.provider,
		settings,
		email,
	);
	return {
		service,
		scopes,
		writes,
		opened,
		notified,
		get opens() {
			return opened.length;
		},
	};
}

/** The seam's `disabled` driver, without reaching for the real one — this is about the pipeline. */
function disabledProvider(): TranscriptionProvider {
	return {
		driver: "disabled",
		enabled: false,
		async transcribe(): Promise<TranscriptionResult> {
			throw new Error("must not be called");
		},
	};
}

/**
 * A provider that ANSWERS, and that opens the audio first.
 *
 * The `open()` matters and is not ceremony: a real driver reads the object, so a fake that skipped
 * it would never exercise the store, would never surface an `ObjectNotFoundError`, and would make
 * this file's tenancy assertion vacuous.
 */
function answering(text: string): TranscriptionProvider {
	return {
		driver: "openai-compatible",
		enabled: true,
		async transcribe(audio) {
			const stream = await audio.open();
			for await (const _chunk of stream) {
				// Drained exactly as the real driver drains it.
			}
			return { text };
		},
	};
}

function failing(options: { readonly retryable: boolean }): TranscriptionProvider & {
	calls: number;
} {
	return {
		driver: "openai-compatible",
		enabled: true,
		calls: 0,
		async transcribe(): Promise<TranscriptionResult> {
			this.calls += 1;
			throw new TranscriptionFailure("the endpoint refused", { retryable: options.retryable });
		},
	};
}

/** A provider that holds the worker open, so the queue's ceiling can be observed. */
function blockingProvider(): { provider: TranscriptionProvider; release: () => void } {
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		release: () => {
			release();
		},
		provider: {
			driver: "openai-compatible",
			enabled: true,
			async transcribe() {
				await gate;
				return { text: "released" };
			},
		},
	};
}

function missingObjectStore(): ObjectStore {
	return {
		driver: "local",
		async getStream(objectKey: string) {
			throw new ObjectNotFoundError(objectKey);
		},
	} as unknown as ObjectStore;
}

/** Lets the fire-and-forget worker run. Two turns: `enqueue` schedules, `drain` awaits. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) {
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
	}
}

// --- the read model ---------------------------------------------------------------------------

function session(): AppSession {
	return {
		session: { activeOrganizationId: ORGANIZATION_ID },
		user: { id: "user-1" },
	} as unknown as AppSession;
}

/**
 * `VoicemailMessagesService.list` against a scripted transaction.
 *
 * The three selects it issues — the box, the page, the counts — resolve in order from a queue, so
 * the fake needs no knowledge of Drizzle's builder shapes beyond "everything chains and the await
 * is the terminal".
 */
function messagesHarness(message: {
	readonly transcription: string | null;
	readonly transcriptionStatus: string;
	readonly transcribedAt: Date | null;
}): { service: VoicemailMessagesService } {
	const results: unknown[][] = [
		[{ id: MAILBOX_ID, mailboxNumber: "1001", mwiEnabled: true }],
		[
			{
				id: MESSAGE_ID,
				voicemailBoxId: MAILBOX_ID,
				folder: "new",
				callerIdName: "Jane",
				callerIdNumber: "+12125550100",
				receivedAt: new Date("2026-08-11T17:00:00.000Z"),
				durationMs: 4_200,
				sizeBytes: 67_200,
				...message,
				callLegRef: null,
				total: 1,
			},
		],
		[{ folder: "new", total: 1 }],
	];

	let index = 0;
	const builder: unknown = new Proxy(
		{},
		{
			get(_target, property) {
				if (property === "then") {
					return (resolve: (value: unknown) => void) => {
						resolve(results[index++] ?? []);
					};
				}
				return () => builder;
			},
		},
	);

	const transaction = { select: () => builder };
	const database = {
		withTenantScope: async <T>(_organizationId: string, work: (t: never) => Promise<T>) =>
			await work(transaction as never),
	} as unknown as PbxDatabaseClient;

	const service = new VoicemailMessagesService(
		{} as never,
		database,
		{ publish: async () => {} } as never,
		{} as never,
	);
	return { service };
}
