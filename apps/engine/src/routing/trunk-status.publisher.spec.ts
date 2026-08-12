import { describe, expect, it } from "bun:test";
import { of, throwError } from "rxjs";
import { TrunkStatusPublisher } from "./trunk-status.publisher";
import type { MediaTrunkEndpointStatusEvent } from "../media/media-event";
import type { RoutingArtifactSource } from "./routing-artifact.source";
import type { ClientProxy } from "@nestjs/microservices";

/**
 * The trunk-health producer's decision layer: what gets published, what is suppressed, and what
 * is dropped because no held artifact can name the endpoint. The subject/payload contract itself
 * is `packages/events`' business and is exercised through the real `makeTrunkEvent` here — a fake
 * envelope would be a second copy of the contract.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const TRUNK = "0195c0f0-1c2f-7000-8000-0000000000b1";

function transition(
	overrides: Partial<MediaTrunkEndpointStatusEvent> = {},
): MediaTrunkEndpointStatusEvent {
	return {
		type: "trunk-endpoint-status",
		endpoint: "carrier-a",
		status: "down",
		reason: "Unreachable",
		latencyMs: 1_240,
		...overrides,
	};
}

function harness(options: { readonly resolves?: boolean; emitFails?: boolean } = {}) {
	const emitted: { subject: string; envelope: Record<string, unknown> }[] = [];
	const client = {
		emit: (subject: string, envelope: Record<string, unknown>) => {
			if (options.emitFails === true) {
				return throwError(() => new Error("broker unavailable"));
			}
			emitted.push({ subject, envelope });
			return of(undefined);
		},
	} as unknown as ClientProxy;
	const routing = {
		findTrunkEndpoint: (endpoint: string) =>
			(options.resolves ?? true) && endpoint === "carrier-a"
				? { organizationId: ORG, trunkId: TRUNK }
				: undefined,
	} as unknown as RoutingArtifactSource;
	return { publisher: new TrunkStatusPublisher(client, routing), emitted };
}

describe("TrunkStatusPublisher", () => {
	it("publishes a resolved transition on the trunk subject with the endpoint in the payload", async () => {
		const h = harness();
		await h.publisher.handle(transition());

		expect(h.emitted).toHaveLength(1);
		const { subject, envelope } = h.emitted[0]!;
		expect(subject).toBe(`trunk.evt.v1.${ORG}.${TRUNK}.status.changed`);
		expect(envelope.type).toBe("status.changed");
		expect(envelope.orgId).toBe(ORG);
		expect(envelope.data).toEqual({
			status: "down",
			reason: "Unreachable",
			latencyMs: 1_240,
			endpoint: "carrier-a",
		});
		expect(h.publisher.stats.published).toBe(1);
	});

	it("suppresses a repeat of the same verdict — the event is a change, not a heartbeat", async () => {
		const h = harness();
		await h.publisher.handle(transition());
		await h.publisher.handle(transition());
		await h.publisher.handle(transition({ status: "up", reason: "Reachable" }));

		expect(h.emitted.map((entry) => (entry.envelope.data as { status: string }).status)).toEqual([
			"down",
			"up",
		]);
		expect(h.publisher.stats.suppressed).toBe(1);
	});

	it("drops an endpoint no artifact names, and publishes nothing for it", async () => {
		// Publishing a guessed subject would file one tenant's outage under another's row, which
		// is the one failure worse than a stale "unknown".
		const h = harness({ resolves: false });
		await h.publisher.handle(transition());

		expect(h.emitted).toHaveLength(0);
		expect(h.publisher.stats.unresolved).toBe(1);
	});

	it("keeps a failed publish out of the suppression map so the retry is not silenced", async () => {
		const options = { emitFails: true };
		const h = harness(options);
		await h.publisher.handle(transition());
		expect(h.publisher.stats.rejected).toBe(1);
		expect(h.emitted).toHaveLength(0);

		// The same verdict again on a recovered broker must publish — it never made it out, so it
		// is still a change as far as the world downstream knows.
		options.emitFails = false;
		await h.publisher.handle(transition());
		expect(h.emitted).toHaveLength(1);
	});
});
