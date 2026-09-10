import { describe, expect, it } from "bun:test";
import { of, throwError } from "rxjs";
import { TollFraudGuardRpcPort } from "./toll-fraud-guard.source";
import type { ClientProxy } from "@nestjs/microservices";

/**
 * The RPC guard's own behaviour, which is almost entirely about what happens when the responder
 * does NOT answer.
 *
 * Fail-open is the claim worth pinning: this gate sits between the dial-plan walk and the first
 * INVITE, so a control plane that is merely unwell must not become a total outbound outage. Every
 * arm below that ends in `allow` is that rule, stated once per way it can be reached.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";

function client(reply: () => ReturnType<ClientProxy["send"]>): ClientProxy {
	return { send: () => reply() } as unknown as ClientProxy;
}

function request(): {
	organizationId: string;
	extensionNumber: string;
	dialedNumber: string;
	now: number;
} {
	return {
		organizationId: ORG,
		extensionNumber: "1001",
		dialedNumber: "+79001234567",
		now: Date.parse("2026-09-10T03:00:00.000Z"),
	};
}

describe("TollFraudGuardRpcPort", () => {
	it("passes a refusal through with its reason and detail", async () => {
		const port = new TollFraudGuardRpcPort(
			client(() =>
				of({
					allowed: false,
					reason: "DESTINATION_COUNTRY_BLOCKED",
					detail: "calls to RU are blocked for this organization",
				}),
			),
		);

		const verdict = await port.authorize(request());

		expect(verdict).toEqual({
			kind: "refuse",
			reason: "DESTINATION_COUNTRY_BLOCKED",
			detail: "calls to RU are blocked for this organization",
		});
		expect(port.stats).toEqual({ calls: 1, refusals: 1, failures: 0 });
	});

	it("accepts a reason it has never heard of, because the responder may be newer than it is", async () => {
		const port = new TollFraudGuardRpcPort(
			client(() => of({ allowed: false, reason: "SOMETHING_ADDED_IN_V1_9", detail: "no" })),
		);

		const verdict = await port.authorize(request());

		expect(verdict.kind).toBe("refuse");
		expect(verdict.kind === "refuse" && verdict.reason).toBe("SOMETHING_ADDED_IN_V1_9");
	});

	it("still refuses when the responder names no reason, rather than silently allowing", async () => {
		const port = new TollFraudGuardRpcPort(client(() => of({ allowed: false })));

		const verdict = await port.authorize(request());

		expect(verdict.kind).toBe("refuse");
		expect(verdict.kind === "refuse" && verdict.reason).toBe("TOLL_FRAUD_REFUSED");
	});

	it("allows when the responder is absent, when it errors, and when its reply is malformed", async () => {
		const absent = new TollFraudGuardRpcPort(
			client(() => throwError(() => new Error("no responders available for request"))),
		);
		const malformed = new TollFraudGuardRpcPort(client(() => of({ allowed: "yes please" })));

		expect(await absent.authorize(request())).toEqual({ kind: "allow" });
		expect(await malformed.authorize(request())).toEqual({ kind: "allow" });
		expect(absent.stats.failures).toBe(1);
		expect(malformed.stats.failures).toBe(1);
	});

	it("allows on a plain success, and asks with the extension and the engine's own clock", async () => {
		let asked: Record<string, unknown> | undefined;
		const port = new TollFraudGuardRpcPort({
			send: (_subject: string, payload: Record<string, unknown>) => {
				asked = payload;
				return of({ allowed: true });
			},
		} as unknown as ClientProxy);

		expect(await port.authorize(request())).toEqual({ kind: "allow" });
		expect(asked).toEqual({
			orgId: ORG,
			extensionNumber: "1001",
			dialedNumber: "+79001234567",
			at: "2026-09-10T03:00:00.000Z",
		});
	});

	it("omits the extension entirely for a leg that has none, so only the org policy applies", async () => {
		let asked: Record<string, unknown> | undefined;
		const port = new TollFraudGuardRpcPort({
			send: (_subject: string, payload: Record<string, unknown>) => {
				asked = payload;
				return of({ allowed: true });
			},
		} as unknown as ClientProxy);

		await port.authorize({ organizationId: ORG, dialedNumber: "+4915112345678", now: 0 });

		expect(asked !== undefined && Object.hasOwn(asked, "extensionNumber")).toBe(false);
	});
});
