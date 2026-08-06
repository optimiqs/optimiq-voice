import { expect } from "chai";
import { emergencyDialedMail, formatDispatchableLocation } from "../../src/mail/mail-templates";
import {
	EMERGENCY_DURABLE,
	EMERGENCY_SUBJECT_FILTER,
} from "../../src/pbx/emergency-addresses/emergency-consumer.service";
import {
	EMERGENCY_EVENT_ID_HEADER,
	EmergencyNotificationService,
} from "../../src/pbx/emergency-addresses/emergency-notification.service";
import type { EmergencyDialedNotice } from "../../src/pbx/emergency-addresses/emergency-notification.service";
import type { NotificationSettings } from "../../src/pbx/org-settings/org-settings.service";

/**
 * Kari's Law delivery.
 *
 * The consumer's own loop is JetStream and is proved live; what is asserted here is everything
 * that decides WHETHER and WHAT — the gate on an unconfigured tenant, the idempotency header a
 * redelivery carries, the fields §9.16(b)(2) names, and the durable/subject pair that decides
 * which messages this process will ever see.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const EVENT_ID = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";

const NOTICE: EmergencyDialedNotice = {
	eventId: EVENT_ID,
	dialedAt: new Date("2026-08-06T14:03:00.000Z"),
	dialed: "9911",
	number: "911",
	callerNumber: "+12125550100",
	callerName: "Jane Doe",
	elin: "+12125559911",
	emergencyAddressId: "019fd3c2-5555-76be-a6b3-b0f1914e39b6",
	trunkName: "primary",
};

interface SentMail {
	readonly to: string;
	readonly subject: string;
	readonly text: string;
	readonly headers: Record<string, string> | undefined;
}

/** A transaction whose selects answer with the rows the test lines up, in call order. */
function fakeTransaction(answers: readonly (readonly Record<string, unknown>[])[]): unknown {
	let call = 0;
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: async () => answers[call++] ?? [],
	};
	return chain;
}

function makeService(
	settings: Partial<NotificationSettings>,
	answers: readonly (readonly Record<string, unknown>[])[] = [[], []],
	delivered = true,
): { service: EmergencyNotificationService; sent: SentMail[] } {
	const sent: SentMail[] = [];
	const database = {
		withTenantScope: async <A>(_organizationId: string, work: (t: never) => Promise<A>) =>
			await work(fakeTransaction(answers) as never),
	};
	const mailer = {
		appUrl: undefined,
		sendRendered: async (
			to: string,
			rendered: { subject: string; text: string },
			options?: { headers?: Record<string, string> },
		) => {
			sent.push({ to, subject: rendered.subject, text: rendered.text, headers: options?.headers });
			return { delivered, transport: "log" as const };
		},
	};
	const orgSettings = {
		readNotificationSettingsFor: async (): Promise<NotificationSettings> => ({
			voicemailToEmailEnabled: true,
			voicemailToEmailIncludeLink: true,
			voicemailToEmailIncludeTranscription: true,
			fromName: undefined,
			replyTo: undefined,
			emergencyNotificationEmails: [],
			...settings,
		}),
	};
	return {
		service: new EmergencyNotificationService(
			database as never,
			mailer as never,
			orgSettings as never,
		),
		sent,
	};
}

describe("emergency notification gating", () => {
	it("sends nothing when the tenant has configured no central location", async () => {
		// The default is empty and empty means nobody: there is no defensible platform-wide default
		// recipient, so the miss is a loud skip rather than a message to a guess.
		const { service, sent } = makeService({ emergencyNotificationEmails: [] });
		const outcome = await service.notify(ORGANIZATION_ID, NOTICE);
		expect(outcome).to.deep.equal({ outcome: "skipped", reason: "no-recipients" });
		expect(sent).to.have.length(0);
		expect(service.stats.skipped).to.equal(1);
	});

	it("is not gated by the voicemail-to-email switch", async () => {
		// That switch is a privacy policy about recorded audio; this is a life-safety notification
		// carrying no recording. Coupling them would let a voicemail decision disable Kari's Law.
		const { service, sent } = makeService({
			voicemailToEmailEnabled: false,
			emergencyNotificationEmails: ["desk@example.com"],
		});
		const outcome = await service.notify(ORGANIZATION_ID, NOTICE);
		expect(outcome.outcome).to.equal("sent");
		expect(sent).to.have.length(1);
	});

	it("notifies every configured recipient once, de-duplicated", async () => {
		const { service, sent } = makeService({
			emergencyNotificationEmails: ["desk@example.com", "ops@example.com", "desk@example.com"],
		});
		const outcome = await service.notify(ORGANIZATION_ID, NOTICE);
		expect(outcome.outcome).to.equal("sent");
		expect(sent.map((message) => message.to)).to.deep.equal([
			"desk@example.com",
			"ops@example.com",
		]);
	});

	it("stamps the event id on every send, so a redelivery is collapsible", async () => {
		// JetStream is at-least-once and the consumer acks before it sends, so a duplicate is
		// expected. A duplicate "somebody dialled 911" is an annoyance; a suppressed one is a
		// compliance failure, so the dedupe is the mail store's, keyed on this header.
		const { service, sent } = makeService({
			emergencyNotificationEmails: ["desk@example.com", "ops@example.com"],
		});
		await service.notify(ORGANIZATION_ID, NOTICE);
		for (const message of sent) {
			expect(message.headers?.[EMERGENCY_EVENT_ID_HEADER]).to.equal(EVENT_ID);
		}
	});

	it("never throws — a relay failure is a named outcome, not an exception into the consumer", async () => {
		const { service } = makeService(
			{ emergencyNotificationEmails: ["desk@example.com"] },
			[[], []],
			false,
		);
		const outcome = await service.notify(ORGANIZATION_ID, NOTICE);
		expect(outcome).to.deep.equal({ outcome: "failed" });
	});

	it("resolves the dispatchable location and the calling extension into the message", async () => {
		const { service, sent } = makeService({ emergencyNotificationEmails: ["desk@example.com"] }, [
			[
				{
					label: "HQ",
					streetLine1: "1 Main St",
					streetLine2: null,
					locationDetail: "Floor 3, Room 314",
					locality: "New York",
					administrativeArea: "NY",
					postalCode: "10001",
					country: "US",
				},
			],
			[{ number: "+12125550100", label: "Reception" }],
		]);
		await service.notify(ORGANIZATION_ID, NOTICE);
		const body = sent[0]?.text ?? "";
		expect(body).to.contain("Floor 3, Room 314");
		expect(body).to.contain("+12125550100");
		expect(body).to.contain("Reception");
	});

	it("says the location is unreadable rather than omitting the line", async () => {
		// "The number has an address on record and we could not read it" and "no address is
		// registered" are different problems, and only one of them is a data-entry error.
		const { service, sent } = makeService({ emergencyNotificationEmails: ["desk@example.com"] }, [
			[],
			[],
		]);
		await service.notify(ORGANIZATION_ID, NOTICE);
		expect(sent[0]?.text ?? "").to.contain("could not be read");
	});
});

describe("emergency notification message", () => {
	it("carries what §9.16(b)(2) names: the number, a callback, a location and the instant", () => {
		const rendered = emergencyDialedMail({
			appName: "Optimiq Voice",
			dialed: "9911",
			number: "911",
			callerNumber: "+12125550100",
			callerName: "Jane Doe",
			callerExtension: "214 (Reception)",
			elin: "+12125559911",
			location: "HQ, 1 Main St, Floor 3, Room 314, New York, NY, 10001, US",
			trunkName: "primary",
			dialedAt: new Date("2026-08-06T14:03:00.000Z"),
		});
		expect(rendered.subject).to.contain("911");
		expect(rendered.subject).to.contain("+12125550100");
		expect(rendered.text).to.contain("Callback:  +12125550100");
		expect(rendered.text).to.contain("Extension: 214 (Reception)");
		expect(rendered.text).to.contain("Floor 3, Room 314");
		expect(rendered.text).to.contain("2026-08-06 14:03:00 UTC");
		// The prefix the user keyed is kept beside what went on the wire: "9911" and "911" are
		// different facts and a dial-plan bug lives in the gap between them.
		expect(rendered.text).to.contain("9911 (sent as 911)");
	});

	it("names a missing callback and a missing location instead of leaving a blank line", () => {
		const rendered = emergencyDialedMail({
			appName: "Optimiq Voice",
			dialed: "911",
			number: "911",
			dialedAt: new Date("2026-08-06T14:03:00.000Z"),
		});
		expect(rendered.text).to.contain("Callback:  not presented");
		expect(rendered.text).to.contain("Location:  not registered for this call");
		expect(rendered.text).to.contain("ELIN:      none");
	});

	it("escapes an attacker-supplied caller name on the HTML side", () => {
		const rendered = emergencyDialedMail({
			appName: "Optimiq Voice",
			dialed: "911",
			number: "911",
			callerName: "<script>alert(1)</script>",
			dialedAt: new Date(),
		});
		expect(rendered.html).to.not.contain("<script>");
		expect(rendered.html).to.contain("&lt;script&gt;");
	});

	it("drops empty address parts rather than rendering a run of commas", () => {
		expect(
			formatDispatchableLocation({
				label: "HQ",
				streetLine1: "1 Main St",
				streetLine2: "   ",
				locationDetail: null,
				locality: "New York",
				administrativeArea: "NY",
				postalCode: "10001",
				country: "US",
			}),
		).to.equal("HQ, 1 Main St, New York, NY, 10001, US");
	});
});

describe("emergency consumer binding", () => {
	it("binds a named durable, so a redeploy resumes rather than replaying every call event", () => {
		expect(EMERGENCY_DURABLE).to.equal("pbx-emergency-notifier");
	});

	it("filters the one subject the engine publishes, dots in the event token and all", () => {
		// `calls.evt.v1.<orgId>.<callId>.<event>` where the event is itself `call.emergency.dialed`,
		// so the tail is four literal tokens and the two wildcards are the tenant and the call.
		expect(EMERGENCY_SUBJECT_FILTER).to.equal("calls.evt.v1.*.*.call.emergency.dialed");
		expect(EMERGENCY_SUBJECT_FILTER.split(".")).to.have.length(8);
	});
});
