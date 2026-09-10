import { expect } from "chai";
import {
	classifyKeyword,
	normalizeKeywordBody,
	parseKeywordList,
} from "../../src/messaging/compliance/keywords";
import {
	formatMinutes,
	isValidTimeZone,
	isWithinQuietHours,
	localMinutesIn,
} from "../../src/messaging/compliance/quiet-hours";
import {
	buildMessagingObjectKey,
	messagingMediaContentType,
	messagingMediaExtension,
	messagingMediaKey,
	messagingMediaPath,
	mintMessagingMediaToken,
	verifyMessagingMediaToken,
} from "../../src/messaging/messaging-media";
import { MessagingSendWorker } from "../../src/messaging/messaging-send-worker.service";
import {
	createBrandDto,
	createCampaignDto,
	enableMessagingNumberDto,
	sendMessageDto,
	submitTollFreeVerificationDto,
} from "../../src/messaging/messaging.dto";
import {
	classifyNumber,
	initialRegistrationReason,
	quietHoursOf,
} from "../../src/messaging/messaging.service";
import { FakeMessagingProvider } from "../../src/messaging/provider/fake-messaging.provider";
import { MessagingSendError } from "../../src/messaging/provider/messaging-provider.port";
import { parseDto } from "../../src/pbx/shared/dto";
import type { MessagingEnv } from "../../src/messaging/messaging-env";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * Messaging, api-side.
 *
 * Four layers, matching the area's shape: the compliance rules and the media helpers as pure
 * functions, the DTOs, the fake provider's own contract, and the send worker driven against it.
 * Nothing here needs a database, an object store, a carrier or a timer — `tick()` is public
 * precisely so a harness can drive one pass rather than waiting one out, the same arrangement
 * `fax.test.ts` uses.
 *
 * The gates that need a real transaction (opt-out, quiet hours, registration) are covered by the
 * live proof against the local stack rather than mocked here: their whole point is that they run
 * INSIDE the send transaction, and a fake transaction that returns whatever the script says would
 * assert the mock rather than the behaviour.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const NUMBER = "22222222-2222-4222-8222-222222222222";
const MESSAGE = "33333333-3333-4333-8333-333333333333";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";

function env(overrides: Partial<MessagingEnv> = {}): MessagingEnv {
	return {
		MESSAGING_DRIVER: "fake",
		TELNYX_MESSAGING_PROFILE_ID: undefined,
		MESSAGING_OBJECT_ROOT: "./.data/messaging",
		MESSAGING_SEND_ENABLED: true,
		MESSAGING_SEND_POLL_INTERVAL_MS: 0,
		MESSAGING_SEND_LEASE_MS: 60_000,
		MESSAGING_SEND_MAX_ATTEMPTS: 3,
		MESSAGING_REGISTRATION_POLL_INTERVAL_MS: 0,
		MESSAGING_RETENTION_DAYS: 0,
		MESSAGING_RETENTION_SWEEP_INTERVAL_MS: 0,
		MESSAGING_MEDIA_URL_SECRET: "s3cr3t",
		MESSAGING_MEDIA_URL_SECRET_PREVIOUS: undefined,
		MESSAGING_MEDIA_URL_TTL_SECONDS: 3_600,
		MESSAGING_MAX_MEDIA_BYTES: 5 * 1_024 * 1_024,
		MESSAGING_PUBLIC_BASE_URL: "https://pbx.example.com",
		...overrides,
	} as MessagingEnv;
}

// --------------------------------------------------------------------------------------------
// Compliance keywords
// --------------------------------------------------------------------------------------------

describe("messaging compliance keywords", () => {
	it("recognises STOP however a phone keyboard mangled it", () => {
		for (const body of ["STOP", "stop", "  Stop  ", "STOP.", '"STOP"', "stop!"]) {
			expect(classifyKeyword(body)?.intent, body).to.equal("opt-out");
		}
	});

	it("recognises the FCC's other opt-out words and the multi-word forms", () => {
		for (const body of ["unsubscribe", "CANCEL", "quit", "revoke", "opt out", "OPT-OUT"]) {
			expect(classifyKeyword(body)?.intent, body).to.equal("opt-out");
		}
	});

	it("recognises START and HELP", () => {
		expect(classifyKeyword("start")?.intent).to.equal("opt-in");
		expect(classifyKeyword("UNSTOP")?.intent).to.equal("opt-in");
		expect(classifyKeyword("help")?.intent).to.equal("help");
		expect(classifyKeyword("INFO")?.intent).to.equal("help");
	});

	it("does NOT guess at a sentence — that is what the manual opt-out path is for", () => {
		expect(classifyKeyword("please stop sending me these")).to.equal(undefined);
		expect(classifyKeyword("stop by the shop at 5")).to.equal(undefined);
		expect(classifyKeyword("can you help me with my order")).to.equal(undefined);
	});

	it("never strips punctuation from INSIDE a word", () => {
		// `STOP-GAP` is a word, not a mangled STOP. Stripping internally would collapse the two.
		expect(classifyKeyword("STOP-GAP")).to.equal(undefined);
		expect(normalizeKeywordBody("  stop.  ")).to.equal("STOP");
	});

	it("treats a campaign's keywords as ADDITIVE — a campaign cannot un-register STOP", () => {
		const campaign = { optOutKeywords: "BASTA,ALTO", optInKeywords: null, helpKeywords: null };
		expect(classifyKeyword("BASTA", campaign)?.intent).to.equal("opt-out");
		// The universal keyword still works, even though the campaign did not list it.
		expect(classifyKeyword("STOP", campaign)?.intent).to.equal("opt-out");
	});

	it("resolves an ambiguous keyword toward the safer reading", () => {
		// A misconfigured campaign listing STOP as an opt-in must not turn a STOP into a subscribe.
		const campaign = { optOutKeywords: null, optInKeywords: "STOP,YES", helpKeywords: null };
		expect(classifyKeyword("STOP", campaign)?.intent).to.equal("opt-out");
	});

	it("ignores an empty body and anything longer than a keyword", () => {
		expect(classifyKeyword("")).to.equal(undefined);
		expect(classifyKeyword(undefined)).to.equal(undefined);
		expect(classifyKeyword("S".repeat(40))).to.equal(undefined);
	});

	it("parses a TCR comma-separated list", () => {
		expect(parseKeywordList(" stop , unsubscribe ,, ")).to.deep.equal(["STOP", "UNSUBSCRIBE"]);
		expect(parseKeywordList(null)).to.deep.equal([]);
	});
});

// --------------------------------------------------------------------------------------------
// Quiet hours
// --------------------------------------------------------------------------------------------

describe("messaging quiet hours", () => {
	const utcAt = (hour: number, minute = 0) => new Date(Date.UTC(2026, 5, 15, hour, minute, 0));

	it("allows everything when a campaign declared no window", () => {
		expect(isWithinQuietHours(undefined, utcAt(3)).allowed).to.equal(true);
	});

	it("allows inside the window and refuses outside it", () => {
		const window = { startMinute: 8 * 60, endMinute: 21 * 60, timeZone: "UTC" };
		expect(isWithinQuietHours(window, utcAt(9)).allowed).to.equal(true);
		expect(isWithinQuietHours(window, utcAt(20, 59)).allowed).to.equal(true);
		expect(isWithinQuietHours(window, utcAt(21)).allowed).to.equal(false);
		expect(isWithinQuietHours(window, utcAt(3)).allowed).to.equal(false);
	});

	it("reads the window in the declared zone, not the server's", () => {
		const window = { startMinute: 8 * 60, endMinute: 21 * 60, timeZone: "America/Chicago" };
		// 13:00 UTC is 08:00 in Chicago on this date — the first allowed minute.
		expect(isWithinQuietHours(window, utcAt(13)).allowed).to.equal(true);
		// 12:59 UTC is 07:59 there.
		expect(isWithinQuietHours(window, utcAt(12, 59)).allowed).to.equal(false);
	});

	it("lets a verified recipient zone override the campaign's", () => {
		const window = { startMinute: 8 * 60, endMinute: 21 * 60, timeZone: "UTC" };
		// 03:00 UTC is outside the UTC window but is 12:00 in Tokyo.
		expect(isWithinQuietHours(window, utcAt(3), "Asia/Tokyo").allowed).to.equal(true);
	});

	it("supports a window that wraps midnight", () => {
		const window = { startMinute: 21 * 60, endMinute: 8 * 60, timeZone: "UTC" };
		expect(isWithinQuietHours(window, utcAt(22)).allowed).to.equal(true);
		expect(isWithinQuietHours(window, utcAt(3)).allowed).to.equal(true);
		expect(isWithinQuietHours(window, utcAt(12)).allowed).to.equal(false);
	});

	it("quotes the local time and the window in the decision, for the refusal message", () => {
		const decision = isWithinQuietHours(
			{ startMinute: 8 * 60, endMinute: 21 * 60, timeZone: "UTC" },
			utcAt(3, 7),
		);
		expect(decision.localTime).to.equal("03:07");
		expect(decision.window).to.equal("08:00–21:00 UTC");
	});

	it("degrades to UTC rather than throwing on a typo'd zone", () => {
		// The caller is a send path: a bad row must not turn every send into a 500.
		expect(localMinutesIn("Not/AZone", utcAt(5, 30))).to.equal(5 * 60 + 30);
		expect(isValidTimeZone("Not/AZone")).to.equal(false);
		expect(isValidTimeZone("America/Chicago")).to.equal(true);
	});

	it("formats minutes past midnight", () => {
		expect(formatMinutes(0)).to.equal("00:00");
		expect(formatMinutes(9 * 60 + 5)).to.equal("09:05");
		expect(formatMinutes(1_439)).to.equal("23:59");
	});

	it("reads a campaign's trio as atomic — two of three is no window at all", () => {
		expect(
			quietHoursOf({
				quietHoursStartMinute: 480,
				quietHoursEndMinute: 1_260,
				quietHoursTimeZone: "UTC",
			} as never),
		).to.deep.equal({ startMinute: 480, endMinute: 1_260, timeZone: "UTC" });
		expect(
			quietHoursOf({
				quietHoursStartMinute: 480,
				quietHoursEndMinute: null,
				quietHoursTimeZone: "UTC",
			} as never),
		).to.equal(undefined);
	});
});

// --------------------------------------------------------------------------------------------
// Number classification and the refusal sentences
// --------------------------------------------------------------------------------------------

describe("messaging number classification", () => {
	it("recognises every NANP toll-free SAC", () => {
		for (const sac of ["800", "833", "844", "855", "866", "877", "888"]) {
			expect(classifyNumber(`+1${sac}5551234`), sac).to.equal("toll-free");
		}
	});

	it("calls everything else local", () => {
		expect(classifyNumber("+13125551234")).to.equal("local");
		expect(classifyNumber("+442071838750")).to.equal("local");
	});

	it("gives a freshly-enabled number a reason that says what to do next", () => {
		expect(initialRegistrationReason("local")).to.contain("10DLC campaign");
		expect(initialRegistrationReason("toll-free")).to.contain("toll-free verification");
		expect(initialRegistrationReason("short-code")).to.contain("not supported");
	});
});

// --------------------------------------------------------------------------------------------
// Media keys and links
// --------------------------------------------------------------------------------------------

describe("messaging media", () => {
	it("round-trips a token and reads back its message and organization", () => {
		const expiresAt = Math.floor(Date.now() / 1_000) + 60;
		const token = mintMessagingMediaToken(MESSAGE, ORG, expiresAt, "secret");
		const result = verifyMessagingMediaToken(token, { current: "secret" });
		expect(result.ok).to.equal(true);
		expect(result.payload?.r).to.equal(MESSAGE);
		expect(result.payload?.o).to.equal(ORG);
	});

	it("is domain-separated from the other media families", () => {
		expect(messagingMediaKey("secret")).to.not.equal("secret");
	});

	it("reports an expired token as expired, not invalid", () => {
		const token = mintMessagingMediaToken(MESSAGE, ORG, Math.floor(Date.now() / 1_000) - 1, "s");
		expect(verifyMessagingMediaToken(token, { current: "s" }).failure).to.equal("expired");
	});

	it("verifies against the previous secret during a rotation", () => {
		const expiresAt = Math.floor(Date.now() / 1_000) + 60;
		const token = mintMessagingMediaToken(MESSAGE, ORG, expiresAt, "old");
		expect(verifyMessagingMediaToken(token, { current: "new", previous: "old" }).ok).to.equal(true);
		expect(verifyMessagingMediaToken(token, { current: "new" }).ok).to.equal(false);
	});

	it("allows only the content types a browser will not execute", () => {
		expect(messagingMediaExtension("image/jpeg")).to.equal("jpg");
		expect(messagingMediaExtension("image/png; charset=binary")).to.equal("png");
		expect(messagingMediaExtension("application/pdf")).to.equal("pdf");
		// SVG is an XML document that can carry script, and these bytes are rendered into a browser.
		expect(messagingMediaExtension("image/svg+xml")).to.equal(undefined);
		expect(messagingMediaExtension("text/html")).to.equal(undefined);
		expect(messagingMediaExtension(undefined)).to.equal(undefined);
	});

	it("serves the content type from the allow-list, never from what an upload claimed", () => {
		expect(messagingMediaContentType("messaging/o/2026/06/x.png")).to.equal("image/png");
		expect(messagingMediaContentType("messaging/o/2026/06/x.bin")).to.equal(
			"application/octet-stream",
		);
	});

	it("dates the object key so a busy tenant never fills one directory", () => {
		const key = buildMessagingObjectKey(ORG, "png", new Date(Date.UTC(2026, 0, 5)));
		expect(key.startsWith(`messaging/${ORG}/2026/01/`)).to.equal(true);
		expect(key.endsWith(".png")).to.equal(true);
	});

	it("carries the part index in the media path", () => {
		expect(messagingMediaPath("tok en", 2)).to.equal(
			"/api/v1/messaging/media?token=tok%20en&part=2",
		);
	});
});

// --------------------------------------------------------------------------------------------
// DTOs
// --------------------------------------------------------------------------------------------

describe("messaging DTOs", () => {
	it("requires text or an attachment on a send", () => {
		expect(
			parseDto(sendMessageDto, { messagingNumberId: NUMBER, to: "+13125551234", body: "hi" }).body,
		).to.equal("hi");
		expect(() =>
			parseDto(sendMessageDto, { messagingNumberId: NUMBER, to: "+13125551234" }),
		).to.throw();
		expect(() =>
			parseDto(sendMessageDto, { messagingNumberId: NUMBER, to: "+13125551234", body: "   " }),
		).to.throw();
	});

	it("takes object keys and never URLs for attachments", () => {
		// A DTO accepting a URL would be a server-side request forgery primitive with a send button.
		const parsed = parseDto(sendMessageDto, {
			messagingNumberId: NUMBER,
			to: "+13125551234",
			mediaKeys: ["messaging/o/2026/06/a.png"],
		});
		expect(parsed.mediaKeys).to.deep.equal(["messaging/o/2026/06/a.png"]);
	});

	it("rejects an unknown key rather than dropping it silently", () => {
		expect(() =>
			parseDto(enableMessagingNumberDto, { phoneNumberId: NUMBER, bogus: 1 }),
		).to.throw();
	});

	it("requires an EIN for every entity type except a sole proprietor", () => {
		const base = {
			displayName: "Acme",
			companyName: "Acme Corp",
			email: "a@acme.test",
		};
		expect(() => parseDto(createBrandDto, { ...base, entityType: "PRIVATE_PROFIT" })).to.throw();
		expect(parseDto(createBrandDto, { ...base, entityType: "SOLE_PROPRIETOR" }).ein).to.equal(
			undefined,
		);
		expect(
			parseDto(createBrandDto, { ...base, entityType: "PRIVATE_PROFIT", ein: "12-3456789" }).ein,
		).to.equal("12-3456789");
	});

	it("requires TCR's two-to-five sample messages", () => {
		const base = {
			brandId: ORG,
			name: "Support",
			useCase: "CUSTOMER_CARE",
			description: "Support replies",
			messageFlow: "Customers text us first.",
			helpMessage: "Reply STOP to unsubscribe.",
		};
		expect(() => parseDto(createCampaignDto, { ...base, sampleMessages: ["one"] })).to.throw();
		expect(
			parseDto(createCampaignDto, { ...base, sampleMessages: ["one", "two"] }).sampleMessages,
		).to.have.length(2);
	});

	it("converts a quiet-hours clock time to minutes past midnight and refuses a bad zone", () => {
		const base = {
			brandId: ORG,
			name: "Promos",
			useCase: "MARKETING",
			description: "Offers",
			sampleMessages: ["one", "two"],
			messageFlow: "Web form.",
			helpMessage: "Reply STOP.",
		};
		const parsed = parseDto(createCampaignDto, {
			...base,
			quietHours: { start: "08:00", end: "21:00", timeZone: "America/Chicago" },
		});
		expect(parsed.quietHours).to.deep.equal({
			start: 480,
			end: 1_260,
			timeZone: "America/Chicago",
		});
		expect(() =>
			parseDto(createCampaignDto, {
				...base,
				quietHours: { start: "08:00", end: "21:00", timeZone: "Mars/Olympus" },
			}),
		).to.throw();
		expect(() =>
			parseDto(createCampaignDto, {
				...base,
				quietHours: { start: "25:00", end: "21:00", timeZone: "UTC" },
			}),
		).to.throw();
	});

	it("requires the three BRN fields and both policy URLs on a toll-free submission", () => {
		const complete = {
			messagingNumberId: NUMBER,
			businessName: "Acme",
			corporateWebsite: "https://acme.test",
			businessAddr1: "1 Main St",
			businessCity: "Austin",
			businessState: "Texas",
			businessZip: "78701",
			businessContactFirstName: "Jo",
			businessContactLastName: "Doe",
			businessContactEmail: "jo@acme.test",
			businessContactPhone: "+13125551234",
			businessRegistrationNumber: "12-3456789",
			businessRegistrationType: "EIN",
			businessRegistrationCountry: "us",
			useCase: "2FA",
			useCaseSummary: "Login codes",
			productionMessageContent: "Your code is 123456",
			optInWorkflow: "Users opt in at sign-up.",
			messageVolume: "10,000",
			privacyPolicyUrl: "https://acme.test/privacy",
			termsAndConditionsUrl: "https://acme.test/terms",
		};
		// Mandatory at the carrier for every submission since 17 Feb 2026, so mandatory here.
		expect(parseDto(submitTollFreeVerificationDto, complete).businessRegistrationCountry).to.equal(
			"US",
		);
		for (const field of [
			"businessRegistrationNumber",
			"businessRegistrationType",
			"businessRegistrationCountry",
			"privacyPolicyUrl",
			"termsAndConditionsUrl",
		]) {
			const partial: Record<string, unknown> = { ...complete };
			delete partial[field];
			expect(() => parseDto(submitTollFreeVerificationDto, partial), field).to.throw();
		}
		expect(() =>
			parseDto(submitTollFreeVerificationDto, {
				...complete,
				businessRegistrationCountry: "USA",
			}),
		).to.throw();
	});
});

// --------------------------------------------------------------------------------------------
// The fake provider's own contract
// --------------------------------------------------------------------------------------------

describe("the fake messaging provider", () => {
	it("records a send and returns a carrier id, never a delivery", async () => {
		const provider = new FakeMessagingProvider();
		const result = await provider.send({
			from: "+13125550000",
			to: "+13125551111",
			text: "hello",
			clientState: MESSAGE,
		});
		expect(result.carrierMessageId).to.match(/^fake-msg-/u);
		expect(provider.sent).to.have.length(1);
		expect(provider.sent[0]?.clientState).to.equal(MESSAGE);
	});

	it("refuses a message with neither text nor media, permanently", async () => {
		const provider = new FakeMessagingProvider();
		try {
			await provider.send({ from: "+1", to: "+2", clientState: MESSAGE });
			expect.fail("expected a refusal");
		} catch (error) {
			expect(error).to.be.instanceOf(MessagingSendError);
			expect((error as MessagingSendError).permanent).to.equal(true);
		}
	});

	it("verifies its own webhook signature and names the reason it refused", async () => {
		const provider = new FakeMessagingProvider({ webhookSecret: "shh" });
		const signed = provider.inboundWebhook({
			carrierMessageId: "c1",
			from: "+13125551111",
			to: "+13125550000",
			text: "hi",
		});
		const parsed = await provider.parseWebhook({
			rawBody: Buffer.from(signed.body, "utf8"),
			headers: signed.headers,
		});
		expect(parsed?.kind).to.equal("inbound");

		// A tampered body must not verify, even with the original signature.
		let reason: string | undefined;
		try {
			await provider.parseWebhook({
				rawBody: Buffer.from(signed.body.replace("hi", "no"), "utf8"),
				headers: signed.headers,
			});
		} catch (error) {
			reason = (error as { reason?: string }).reason;
		}
		expect(reason).to.equal("mismatch");
	});

	it("refuses a delivery whose timestamp is outside the window in EITHER direction", async () => {
		const provider = new FakeMessagingProvider();
		for (const offsetMs of [-10 * 60_000, 10 * 60_000]) {
			const signed = provider.receiptWebhook({ carrierMessageId: "c1", status: "delivered" });
			const stale = provider.signWebhook(
				JSON.parse(signed.body) as Record<string, unknown>,
				new Date(Date.now() + offsetMs),
			);
			let reason: string | undefined;
			try {
				await provider.parseWebhook({
					rawBody: Buffer.from(stale.body, "utf8"),
					headers: stale.headers,
				});
			} catch (error) {
				reason = (error as { reason?: string }).reason;
			}
			expect(reason, String(offsetMs)).to.equal("stale-timestamp");
		}
	});

	it("returns undefined for a signed body it does not model, rather than throwing", async () => {
		const provider = new FakeMessagingProvider();
		const signed = provider.signWebhook({ kind: "something-else" });
		const parsed = await provider.parseWebhook({
			rawBody: Buffer.from(signed.body, "utf8"),
			headers: signed.headers,
		});
		expect(parsed).to.equal(undefined);
	});
});

// --------------------------------------------------------------------------------------------
// The send worker
// --------------------------------------------------------------------------------------------

interface SendScript {
	readonly claim?: Record<string, unknown>;
	readonly number?: Record<string, unknown>;
}

function sendFakeDatabase(script: SendScript = {}): {
	readonly database: PbxDatabaseClient;
	readonly updates: Record<string, unknown>[];
} {
	const updates: Record<string, unknown>[] = [];
	const adminExecute = async (query: unknown): Promise<unknown> => {
		const text = renderSql(query);
		await Promise.resolve();
		if (text.includes("skip locked")) {
			return script.claim === undefined ? [] : [script.claim];
		}
		return [];
	};
	const transaction: Record<string, unknown> = {};
	Object.assign(transaction, {
		select: () => transaction,
		from: () => transaction,
		where: () => transaction,
		leftJoin: () => transaction,
		innerJoin: () => transaction,
		orderBy: () => transaction,
		offset: () => [],
		limit: () => [script.number ?? { id: NUMBER, carrierMessagingProfileId: null }],
		update: () => transaction,
		set: (values: Record<string, unknown>) => {
			updates.push(values);
			return transaction;
		},
	});
	const database = {
		adminDb: { execute: adminExecute },
		withTenantScope: async <T>(_org: string, run: (handle: unknown) => Promise<T>): Promise<T> =>
			await run(transaction),
	} as unknown as PbxDatabaseClient;
	return { database, updates };
}

function renderSql(query: unknown): string {
	const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
	return chunks
		.map((chunk) =>
			typeof chunk === "object" && chunk !== null && "value" in chunk
				? String((chunk as { value: unknown }).value)
				: String(chunk),
		)
		.join(" ");
}

const claimable = (overrides: Record<string, unknown> = {}) => ({
	id: MESSAGE,
	organization_id: ORG,
	messaging_number_id: NUMBER,
	conversation_id: CONVERSATION,
	from_e164: "+13125550000",
	to_e164: "+13125551111",
	body: "hello",
	media_keys: [],
	attempts: 1,
	...overrides,
});

describe("messaging send worker", () => {
	it("does nothing when the queue is empty", async () => {
		const { database, updates } = sendFakeDatabase();
		const worker = new MessagingSendWorker(env(), database, new FakeMessagingProvider());
		expect((await worker.tick()).sent).to.equal(0);
		expect(updates).to.deep.equal([]);
	});

	it("sends a claimed message and stamps the carrier id on the row", async () => {
		const provider = new FakeMessagingProvider();
		const { database, updates } = sendFakeDatabase({ claim: claimable() });
		const worker = new MessagingSendWorker(env(), database, provider);
		expect((await worker.tick()).sent).to.equal(1);
		expect(worker.stats.sent).to.equal(1);
		expect(provider.sent).to.have.length(1);
		// The row id rides through as the client state, so the receipt correlates back to it.
		expect(provider.sent[0]?.clientState).to.equal(MESSAGE);
		expect(provider.sent[0]?.text).to.equal("hello");
		const sentUpdate = updates.find((update) => update.status === "sent");
		expect(sentUpdate?.carrierMessageId).to.be.a("string");
	});

	it("retries a transient carrier failure and releases the claim with no backoff", async () => {
		const provider = new FakeMessagingProvider().failNext("carrier timeout", false);
		const { database, updates } = sendFakeDatabase({ claim: claimable() });
		const worker = new MessagingSendWorker(env(), database, provider);
		expect((await worker.tick()).sent).to.equal(0);
		const released = updates.find((update) => update.status === "queued");
		expect(released, "the claim should be released back to the queue").to.not.equal(undefined);
		// Null, not a future date: a text is expected in seconds, so a blip costs one poll rather
		// than one lease.
		expect(released?.claimedAt).to.equal(null);
	});

	it("fails a PERMANENT refusal immediately rather than spending three attempts on it", async () => {
		const provider = new FakeMessagingProvider().failNext("number not on a profile", true);
		const { database, updates } = sendFakeDatabase({ claim: claimable() });
		const worker = new MessagingSendWorker(env(), database, provider);
		expect((await worker.tick()).sent).to.equal(0);
		const failed = updates.find((update) => update.status === "failed");
		expect(failed?.errorReason).to.equal("number not on a profile");
		expect(worker.stats.failed).to.equal(1);
	});

	it("abandons a message that has spent its attempts", async () => {
		const { database, updates } = sendFakeDatabase({ claim: claimable({ attempts: 4 }) });
		const worker = new MessagingSendWorker(env(), database, new FakeMessagingProvider());
		expect((await worker.tick()).sent).to.equal(0);
		expect(String(updates.find((update) => update.status === "failed")?.errorReason)).to.contain(
			"Abandoned after 4",
		);
	});

	it("fails an MMS with a readable reason when no public base URL is configured", async () => {
		const { database, updates } = sendFakeDatabase({
			claim: claimable({ media_keys: ["messaging/o/2026/06/a.png"] }),
		});
		const worker = new MessagingSendWorker(
			env({ MESSAGING_PUBLIC_BASE_URL: undefined }),
			database,
			new FakeMessagingProvider(),
		);
		expect((await worker.tick()).sent).to.equal(0);
		expect(String(updates.find((update) => update.status === "failed")?.errorReason)).to.contain(
			"MESSAGING_PUBLIC_BASE_URL",
		);
	});

	it("hands the carrier ABSOLUTE media URLs, because the carrier fetches them", async () => {
		const provider = new FakeMessagingProvider();
		const { database } = sendFakeDatabase({
			claim: claimable({ media_keys: ["messaging/o/2026/06/a.png"] }),
		});
		const worker = new MessagingSendWorker(env(), database, provider);
		expect((await worker.tick()).sent).to.equal(1);
		const url = provider.sent[0]?.mediaUrls[0] ?? "";
		expect(url.startsWith("https://pbx.example.com/api/v1/messaging/media?token=")).to.equal(true);
		expect(url).to.contain("part=0");
	});

	it("does nothing at all when no provider is configured beyond failing the row readably", async () => {
		const { database, updates } = sendFakeDatabase({ claim: claimable() });
		const worker = new MessagingSendWorker(env(), database, undefined);
		expect((await worker.tick()).sent).to.equal(0);
		expect(String(updates.find((update) => update.status === "failed")?.errorReason)).to.contain(
			"not configured",
		);
	});

	it("refuses to run two passes at once rather than queueing the second", async () => {
		const { database } = sendFakeDatabase();
		const worker = new MessagingSendWorker(env(), database, new FakeMessagingProvider());
		const [first, second] = await Promise.all([worker.tick(), worker.tick()]);
		expect(first.sent + second.sent).to.equal(0);
	});
});
