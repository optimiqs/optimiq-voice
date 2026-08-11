import { Readable } from "node:stream";
import { expect } from "chai";
import {
	TRANSCRIPTION_UNAVAILABLE,
	VoicemailEmailService,
} from "../../src/pbx/voicemail-boxes/voicemail-email.service";
import { VoicemailTranscriptionService } from "../../src/pbx/voicemail-boxes/voicemail-transcription.service";
import { loadTranscriptionEnv, TranscriptionFailure } from "../../src/transcription";
import type { NotificationSettings } from "../../src/pbx/org-settings/org-settings.service";
import type { ObjectStore } from "../../src/storage";
import type { TranscriptionProvider } from "../../src/transcription";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * WHEN the voicemail notification is sent, which is a different question from what is in it.
 *
 * `voicemailToEmailIncludeTranscription` was a promise the ordering could not keep. The mail went
 * out at filing time and the transcription started after it, so a tenant that had turned the setting
 * on got a notification with no transcript — every message, every time. The setting read as
 * configured and behaved as off, which is the worst of the three possible states.
 *
 * The fix is a sequencing rule with one switch, and the tests below are that rule stated as
 * behaviour:
 *
 * > **Transcript not wanted, or this message is not being transcribed → send now, unchanged.
 * > Transcript wanted and the message is `pending` → send at settlement, and never twice.**
 *
 * The negative half matters more than the positive one. Almost every mailbox in almost every
 * deployment is in the first case — no provider configured, or a box that never asked — and a change
 * that delayed THOSE notifications would be a regression measured in every voicemail the platform
 * sends. So "immediate stays immediate" is asserted from several directions.
 */

const ORGANIZATION_ID = "00000000-0000-7000-8000-0000000000a1";
const MAILBOX_ID = "00000000-0000-7000-8000-0000000000c3";
const MESSAGE_ID = "00000000-0000-7000-8000-0000000000d4";
const OBJECT_KEY = `${ORGANIZATION_ID}/${MESSAGE_ID}.wav`;

const FAST_RETRIES = {
	TRANSCRIBE_BASE_URL: "https://api.example.test/v1",
	TRANSCRIBE_MODEL: "whisper-1",
	TRANSCRIBE_RETRY_BASE_MS: "0",
	TRANSCRIBE_MAX_BACKOFF_MS: "0",
} satisfies NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------------------------
// 1. The switch: which messages wait
// ---------------------------------------------------------------------------------------------

describe("whether a voicemail notification waits for its transcript", () => {
	it("does not wait when the organization has not asked for the transcript", async () => {
		const { service } = emailHarness({ settings: { voicemailToEmailIncludeTranscription: false } });
		expect(await service.deferForTranscription(ORGANIZATION_ID)).to.equal(false);
	});

	it("waits when the organization has asked for it", async () => {
		const { service } = emailHarness({ settings: { voicemailToEmailIncludeTranscription: true } });
		expect(await service.deferForTranscription(ORGANIZATION_ID)).to.equal(true);
	});

	it("does not wait when voicemail-to-email is off entirely", async () => {
		// Deferring a notification the tenant has switched off would be waiting ninety seconds in order
		// to skip.
		const { service } = emailHarness({
			settings: { voicemailToEmailEnabled: false, voicemailToEmailIncludeTranscription: true },
		});
		expect(await service.deferForTranscription(ORGANIZATION_ID)).to.equal(false);
	});

	it("does not wait when the policy cannot be read at all", async () => {
		// A settings read that fails must not hold a notification hostage. Sending now, without a
		// transcript, is the failure mode this feature is allowed to have.
		const { service } = emailHarness({ settingsError: new Error("the pool is gone") });
		expect(await service.deferForTranscription(ORGANIZATION_ID)).to.equal(false);
	});
});

// ---------------------------------------------------------------------------------------------
// 2. Exactly once, whoever gets there first
// ---------------------------------------------------------------------------------------------

describe("the voicemail notification's once-only guarantee", () => {
	it("sends once and refuses the second caller, which is the deferred path's normal case", async () => {
		// Three senders can reach the same message — the transcription worker, its budget timer, and
		// the back-fill — and two of them can be in a different process. The claim is on the row for
		// exactly that reason.
		const { service, sent, row } = emailHarness({});

		const first = await service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);
		const second = await service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(first.outcome).to.equal("sent");
		expect(second).to.deep.equal({ outcome: "skipped", reason: "already-sent" });
		expect(sent).to.have.length(1);
		expect(row.emailSentAt).to.be.instanceOf(Date);
	});

	it("gives the claim back when the relay refuses, because nothing was delivered", async () => {
		// The one place the once-only rule bends, and it bends in the safe direction: holding a claim
		// for a send that did not happen would let a relay that was briefly down suppress a
		// notification permanently.
		const { service, row } = emailHarness({ delivered: false });

		const outcome = await service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(outcome).to.deep.equal({ outcome: "failed" });
		expect(row.emailSentAt).to.equal(null);
	});

	it("re-sends after a failure, rather than treating the attempt as spent", async () => {
		const harness = emailHarness({ delivered: false });
		await harness.service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);
		harness.delivered = true;

		const retried = await harness.service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(retried.outcome).to.equal("sent");
		// One DELIVERY out of two attempts: the first never reached anybody, which is why releasing the
		// claim cannot produce a duplicate.
		expect(harness.sent).to.have.length(1);
	});

	it("does not claim a message it was never going to send", async () => {
		// `email_sent_at` records a SEND, not a decision. A mailbox set to `none` that came back marked
		// as notified would make the column useless for the question it exists to answer.
		const { service, row } = emailHarness({ box: { emailMode: "none" } });

		const outcome = await service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(outcome).to.deep.equal({ outcome: "skipped", reason: "mailbox-mode-none" });
		expect(row.emailSentAt).to.equal(null);
	});

	it("does not claim when the organization has voicemail-to-email off", async () => {
		const { service, row } = emailHarness({ settings: { voicemailToEmailEnabled: false } });

		const outcome = await service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(outcome).to.deep.equal({ outcome: "skipped", reason: "org-disabled" });
		expect(row.emailSentAt).to.equal(null);
	});
});

// ---------------------------------------------------------------------------------------------
// 3. What the mail says where the transcript goes
// ---------------------------------------------------------------------------------------------

describe("the transcript section of a voicemail notification", () => {
	it("carries the transcript when the provider answered", async () => {
		const { service, sent } = emailHarness({
			message: { transcription: "call me back on Tuesday", transcriptionStatus: "done" },
		});

		await service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(sent[0]?.text).to.contain("call me back on Tuesday");
		expect(sent[0]?.text).to.not.contain(TRANSCRIPTION_UNAVAILABLE);
	});

	it("says the transcript is unavailable when the provider refused", async () => {
		// Not an omission. A notification with no transcript section reads as "this mailbox does not do
		// transcription"; one that says so reads as "something went wrong", which is the difference
		// between a user who shrugs and a user who tells an administrator.
		const { service, sent } = emailHarness({
			message: { transcription: null, transcriptionStatus: "failed" },
		});

		await service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(sent[0]?.text).to.contain(TRANSCRIPTION_UNAVAILABLE);
	});

	it("says the same when the budget expired with the message still pending", async () => {
		const { service, sent } = emailHarness({
			message: { transcription: null, transcriptionStatus: "pending" },
		});

		await service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(sent[0]?.text).to.contain(TRANSCRIPTION_UNAVAILABLE);
	});

	it("says NOTHING for a mailbox that does not do transcription", async () => {
		// The no-regression assertion. `disabled` is the status of every message in every deployment
		// without a provider, and telling all of them that a transcript is unavailable would be this
		// feature leaking into mailboxes that never asked for it.
		const { service, sent } = emailHarness({
			message: { transcription: null, transcriptionStatus: "disabled" },
		});

		await service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(sent[0]?.text).to.not.contain(TRANSCRIPTION_UNAVAILABLE);
		expect(sent[0]?.text.toLowerCase()).to.not.contain("transcription");
	});

	it("says nothing when the organization did not ask for a transcript at all", async () => {
		const { service, sent } = emailHarness({
			settings: { voicemailToEmailIncludeTranscription: false },
			message: { transcription: "would be wrong", transcriptionStatus: "done" },
		});

		await service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(sent[0]?.text).to.not.contain("would be wrong");
		expect(sent[0]?.text).to.not.contain(TRANSCRIPTION_UNAVAILABLE);
	});

	it("treats an empty transcript as an answer, not as unavailable", async () => {
		// A three-second message of hold music transcribes to nothing, and `done` with an empty string
		// is a real result — the reason the status column exists at all.
		const { service, sent } = emailHarness({
			message: { transcription: "", transcriptionStatus: "done" },
		});

		await service.notify(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);

		expect(sent[0]?.text).to.not.contain(TRANSCRIPTION_UNAVAILABLE);
	});
});

// ---------------------------------------------------------------------------------------------
// 4. The pipeline: who actually triggers the deferred send
// ---------------------------------------------------------------------------------------------

describe("the transcription pipeline's deferred notification", () => {
	it("sends nothing when the caller did not ask for deferral", async () => {
		// The unchanged path: the consumer already sent the mail at filing time, so the pipeline must
		// not send a second one.
		const { service, notified } = pipeline({ provider: answering("hello") });

		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);
		await settle();

		expect(notified).to.deep.equal([]);
	});

	it("sends once the transcription is done, which is the whole point of deferring", async () => {
		const { service, notified } = pipeline({ provider: answering("hello") });

		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID, { deferredEmail: true });
		await settle();

		expect(notified).to.deep.equal([MESSAGE_ID]);
		expect(service.stats.deferredEmails).to.equal(1);
	});

	it("still sends when the transcription FAILED, so a bad provider cannot eat the mail", async () => {
		const { service, notified } = pipeline({
			provider: failing(),
			env: { ...FAST_RETRIES },
		});

		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID, { deferredEmail: true });
		await settle();

		expect(notified).to.deep.equal([MESSAGE_ID]);
	});

	it("sends on the budget when nothing settles, and counts the timeout", async () => {
		// The budget is what makes a notification LATE rather than absent when a provider hangs past
		// its own timeout or a queue refuses the job.
		const gate = blockingProvider();
		const { service, notified } = pipeline({
			provider: gate.provider,
			env: { ...FAST_RETRIES, TRANSCRIBE_EMAIL_WAIT_MS: "0" },
		});

		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID, { deferredEmail: true });
		await settle();

		expect(notified).to.deep.equal([MESSAGE_ID]);
		expect(service.stats.timedOutEmails).to.equal(1);
		gate.release();
		await settle();
	});

	it("arms the budget even for a message the full queue refused", async () => {
		// A dropped job is exactly the message whose notification nothing else is going to send. The
		// row stays `pending` for the back-fill; the mail does not wait for it.
		const gate = blockingProvider();
		const { service, notified } = pipeline({
			provider: gate.provider,
			env: { ...FAST_RETRIES, TRANSCRIBE_QUEUE_LIMIT: "1", TRANSCRIBE_EMAIL_WAIT_MS: "0" },
		});

		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, "held", { deferredEmail: true });
		await settle();
		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, "queued", { deferredEmail: true });
		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, "dropped", { deferredEmail: true });
		await settle();

		expect(service.stats.dropped).to.equal(1);
		expect(notified).to.contain("dropped");
		gate.release();
		await settle();
	});

	it("sends EXACTLY once when the worker and the budget both fire", async () => {
		// The overlap this design has to survive, and the one an in-memory flag would get right in one
		// process and wrong across two. The email service's row-level claim is what makes it once; the
		// pipeline is free to ask twice.
		const { service, sent } = pipeline({
			provider: answering("hello"),
			env: { ...FAST_RETRIES, TRANSCRIBE_EMAIL_WAIT_MS: "0" },
			realEmail: true,
		});

		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID, { deferredEmail: true });
		await settle();

		expect(sent).to.have.length(1);
	});

	it("drops its pending budgets on shutdown, leaving the row for the back-fill", async () => {
		// Firing a timer during a shutdown would race a mail send against a closing database pool. The
		// row is `pending` with a null `email_sent_at`, which is precisely the pair the back-fill takes.
		const gate = blockingProvider();
		const { service, notified } = pipeline({
			provider: gate.provider,
			env: { ...FAST_RETRIES, TRANSCRIBE_EMAIL_WAIT_MS: "0" },
		});

		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID, { deferredEmail: true });
		await service.onApplicationShutdown();
		await settle();

		expect(notified).to.deep.equal([]);
		gate.release();
	});

	it("holds the message id while it works, so the back-fill can exclude it", async () => {
		const gate = blockingProvider();
		const { service } = pipeline({ provider: gate.provider });

		service.enqueue(ORGANIZATION_ID, MAILBOX_ID, MESSAGE_ID);
		await settle();
		expect(service.heldMessageIds()).to.deep.equal([MESSAGE_ID]);

		gate.release();
		await settle();
		expect(service.heldMessageIds()).to.deep.equal([]);
	});
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface SentMail {
	readonly to: string;
	readonly subject: string;
	readonly text: string;
}

interface MessageRow {
	transcription: string | null;
	transcriptionStatus: string;
	emailSentAt: Date | null;
}

interface EmailHarness {
	readonly service: VoicemailEmailService;
	readonly sent: SentMail[];
	readonly row: MessageRow;
	delivered: boolean;
}

/**
 * `VoicemailEmailService` against a message row that models the ONE thing the design leans on: an
 * `email_sent_at` update that succeeds for the first caller and matches nothing for the second.
 *
 * The row is real state rather than a scripted answer, because every assertion in section 2 is about
 * what the SECOND call sees.
 */
function emailHarness(options: {
	readonly settings?: Partial<NotificationSettings>;
	readonly settingsError?: Error;
	readonly box?: Record<string, unknown>;
	readonly message?: Partial<MessageRow>;
	readonly delivered?: boolean;
}): EmailHarness {
	const sent: SentMail[] = [];
	const row: MessageRow = {
		transcription: options.message?.transcription ?? null,
		transcriptionStatus: options.message?.transcriptionStatus ?? "disabled",
		emailSentAt: options.message?.emailSentAt ?? null,
	};

	const box = {
		mailboxNumber: "1001",
		label: "Sales",
		emailAddress: "box@example.test",
		emailMode: "notify",
		...options.box,
	};
	const message = {
		callerIdName: "Jane",
		callerIdNumber: "+12125550100",
		receivedAt: new Date("2026-08-11T17:00:00.000Z"),
		durationMs: 4_200,
		get transcription() {
			return row.transcription;
		},
		get transcriptionStatus() {
			return row.transcriptionStatus;
		},
	};

	let selects = 0;
	const transaction = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => (selects++ === 0 ? [box] : [message]),
				}),
			}),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				const apply = (): { id: string }[] => {
					if (values.emailSentAt === null) {
						row.emailSentAt = null;
						return [];
					}
					if (row.emailSentAt !== null) {
						// The compare-and-set that lost: `email_sent_at is null` matched nothing.
						return [];
					}
					row.emailSentAt = values.emailSentAt as Date;
					return [{ id: MESSAGE_ID }];
				};
				return {
					where: () => {
						const result = apply();
						return {
							returning: async () => result,
							then: (resolve: (value: unknown) => void) => {
								resolve(result);
							},
						};
					},
				};
			},
		}),
	};

	const database = {
		withTenantScope: async <T>(_organizationId: string, work: (t: never) => Promise<T>) => {
			selects = 0;
			return await work(transaction as never);
		},
	} as unknown as PbxDatabaseClient;

	const harness: EmailHarness = {
		sent,
		row,
		delivered: options.delivered ?? true,
		service: new VoicemailEmailService(
			{ PBX_VOICEMAIL_URL_SECRET: undefined } as never,
			database,
			{
				appUrl: undefined,
				sendRendered: async (to: string, rendered: { subject: string; text: string }) => {
					if (!harness.delivered) {
						return { delivered: false, transport: "log" as const };
					}
					sent.push({ to, subject: rendered.subject, text: rendered.text });
					return { delivered: true, transport: "log" as const };
				},
			} as never,
			{
				readNotificationSettingsFor: async (): Promise<NotificationSettings> => {
					if (options.settingsError !== undefined) {
						throw options.settingsError;
					}
					return {
						voicemailToEmailEnabled: true,
						voicemailToEmailIncludeLink: false,
						voicemailToEmailIncludeTranscription: true,
						fromName: undefined,
						replyTo: undefined,
						emergencyNotificationEmails: [],
						...options.settings,
					};
				},
			} as never,
		),
	};
	return harness;
}

/**
 * The transcription service wired to either a recording stub or a REAL email service.
 *
 * The stub is what most of section 4 needs — it answers "who asked for a send" — and the real one is
 * what the exactly-once test needs, because the guarantee lives in the email service's claim rather
 * than anywhere in the pipeline.
 */
function pipeline(options: {
	readonly provider: TranscriptionProvider;
	readonly env?: NodeJS.ProcessEnv;
	readonly realEmail?: boolean;
}): {
	service: VoicemailTranscriptionService;
	notified: string[];
	sent: SentMail[];
} {
	const notified: string[] = [];
	const transaction = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => [
						{ objectKey: OBJECT_KEY, sizeBytes: 12, transcriptionStatus: "pending" },
					],
				}),
			}),
		}),
		update: () => ({
			set: () => ({
				where: async () => {
					// The pipeline's own writes are `voicemailTranscription.test.ts`'s subject.
				},
			}),
		}),
	};
	const database = {
		withTenantScope: async <T>(_organizationId: string, work: (t: never) => Promise<T>) =>
			await work(transaction as never),
	} as unknown as PbxDatabaseClient;

	const store = {
		driver: "local",
		async getStream() {
			return Readable.from([Buffer.from("RIFF....WAVE")]);
		},
	} as unknown as ObjectStore;

	const real = emailHarness({});
	const email =
		options.realEmail === true
			? real.service
			: ({
					async notify(_organizationId: string, _mailboxId: string, messageId: string) {
						notified.push(messageId);
						return { outcome: "sent", to: "box@example.test", linked: false };
					},
				} as unknown as VoicemailEmailService);

	return {
		service: new VoicemailTranscriptionService(
			database,
			store,
			options.provider,
			loadTranscriptionEnv(options.env ?? { ...FAST_RETRIES }),
			email,
		),
		notified,
		sent: real.sent,
	};
}

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

function failing(): TranscriptionProvider {
	return {
		driver: "openai-compatible",
		enabled: true,
		async transcribe() {
			throw new TranscriptionFailure("the endpoint refused", { retryable: false });
		},
	};
}

/** A provider that holds the worker open, so the budget can be observed beating it. */
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

/** Lets the fire-and-forget worker, and a zero-millisecond budget, run. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 12; turn += 1) {
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
	}
}
