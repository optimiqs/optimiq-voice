import { expect } from "chai";
import { conferenceControlRequestSchema } from "@optimiq-voice/events/schemas";
import {
	emptyConferenceModerationDto,
	setConferenceVolumeDto,
} from "../../src/pbx/conferences/conference-moderation.dto";
import { ConferenceModerationService } from "../../src/pbx/conferences/conference-moderation.service";
import type { ConferenceControlClient } from "../../src/pbx/conferences/conference-control.client";
import type { AppSession } from "@optimiq-voice/auth";
import type {
	ConferenceClaim,
	ConferenceControlRequest,
	ConferenceControlResponse,
} from "@optimiq-voice/events/schemas";

/**
 * The moderation surface's authorization and its instance routing, over fakes.
 *
 * The point of these is the DECISIONS: who may moderate, which engine gets asked, when the walk
 * stops, and which refusal becomes which status. The NATS round trip and the KV read are
 * `verify-live.ts`'s job, against a real broker.
 *
 * The routing tests are the ones worth having. Everything about this surface that could go wrong at
 * three in the morning is in the fan-out: a command sent to a neighbour that cheerfully says "not
 * mine", turning a real media failure into a 404 nobody can act on.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const CONFERENCE_ID = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const USER_ID = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const LEG = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";
const NOW = Date.now();

function sessionFor(permissions: readonly string[]): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER_ID,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: ORGANIZATION_ID,
		},
		user: { id: USER_ID, email: "u@test", name: "U", emailVerified: true },
		permissions: permissions as never,
	};
}

function claimWith(instances: Record<string, number>): ConferenceClaim {
	return {
		orgId: ORGANIZATION_ID,
		claimedAt: NOW,
		conferenceId: CONFERENCE_ID,
		bridgeId: "bridge-1",
		contributions: Object.fromEntries(
			Object.entries(instances).map(([instanceId, expiresAt]) => [
				instanceId,
				{ memberCount: 1, moderatorPresent: false, expiresAt },
			]),
		),
	};
}

function refusal(
	instanceId: string,
	reason: ConferenceControlResponse["reason"],
): ConferenceControlResponse {
	return {
		ok: false,
		action: "mute",
		instanceId,
		memberCount: 0,
		reason,
		error: `refused by ${instanceId}`,
	};
}

/**
 * A client whose only job is to hand back canned answers and record what it was asked.
 *
 * `contributors` is the REAL implementation, not a stub, because the lease filter is one of the
 * things worth testing: an expired contribution is an instance that has crashed, and addressing it
 * costs a person a full request timeout.
 */
function fakeClient(options: {
	readonly claim?: ConferenceClaim;
	readonly answers?: Record<string, ConferenceControlResponse>;
	readonly ready?: boolean;
}): { client: ConferenceControlClient; asked: string[]; sent: ConferenceControlRequest[] } {
	const asked: string[] = [];
	const sent: ConferenceControlRequest[] = [];
	const client = {
		get isReady() {
			return options.ready ?? true;
		},
		claim: async () => {
			await Promise.resolve();
			return options.claim;
		},
		contributors: (claim: ConferenceClaim, nowMs = NOW) =>
			Object.entries(claim.contributions)
				.filter(([, contribution]) => contribution.expiresAt > nowMs)
				.map(([instanceId]) => instanceId)
				.sort(),
		send: async (instanceId: string, request: ConferenceControlRequest) => {
			asked.push(instanceId);
			sent.push(request);
			await Promise.resolve();
			return options.answers?.[instanceId] ?? refusal(instanceId, "unknown-member");
		},
	} as unknown as ConferenceControlClient;
	return { client, asked, sent };
}

const MODERATOR = sessionFor(["conferences.read", "conferences.moderate"]);

async function failure(promise: Promise<unknown>): Promise<Record<string, unknown>> {
	try {
		await promise;
	} catch (error) {
		const nest = error as { getResponse?: () => Record<string, unknown> };
		if (typeof nest.getResponse !== "function") {
			throw error;
		}
		return nest.getResponse();
	}
	throw new Error("the call was expected to fail and did not");
}

describe("conference moderation authorization", () => {
	/**
	 * `conferences.read` is the route's floor and `conferences.moderate` is the decision, so a caller
	 * holding only the first gets a refusal that NAMES the missing grant. The alternative — putting
	 * the grant on the decorator — produces the same 403 for a plain user and for a manager whose
	 * grant was withheld, and the second files a ticket saying the button is broken.
	 */
	it("refuses a caller who may see conferences and may not moderate them", async () => {
		const { client, asked } = fakeClient({ claim: claimWith({ "engine-a": NOW + 30_000 }) });
		const service = new ConferenceModerationService(client);

		const body = await failure(
			service.moderate(sessionFor(["conferences.read"]), CONFERENCE_ID, "mute", {
				memberRef: LEG,
			}),
		);

		expect(body["code"]).to.equal("CONFERENCE_MODERATE_FORBIDDEN");
		expect(String(body["message"])).to.contain("conferences.moderate");
		// And nothing was sent. A refusal that had already muted somebody would be the worst of both.
		expect(asked).to.deep.equal([]);
	});

	it("lets a moderator through", async () => {
		const { client } = fakeClient({
			claim: claimWith({ "engine-a": NOW + 30_000 }),
			answers: {
				"engine-a": {
					ok: true,
					action: "mute",
					instanceId: "engine-a",
					memberCount: 3,
					memberRef: LEG,
					muted: true,
					deafened: false,
					moderator: false,
					talkGainPercent: 100,
					listenGainPercent: 100,
				},
			},
		});
		const service = new ConferenceModerationService(client);

		const { data } = await service.moderate(MODERATOR, CONFERENCE_ID, "mute", { memberRef: LEG });

		expect(data.muted).to.equal(true);
		expect(data.memberCount).to.equal(3);
		// The engine's own address is NOT on the wire view: it is meaningless to a browser, and a
		// field in a response body is a field a client starts sending back.
		expect(data).to.not.have.property("instanceId");
	});
});

describe("finding the engine that holds the member", () => {
	it("asks every contributor until one stops saying 'not mine'", async () => {
		const { client, asked } = fakeClient({
			claim: claimWith({
				"engine-a": NOW + 30_000,
				"engine-b": NOW + 30_000,
				"engine-c": NOW + 30_000,
			}),
			answers: {
				"engine-b": {
					ok: true,
					action: "mute",
					instanceId: "engine-b",
					memberCount: 2,
					memberRef: LEG,
					muted: true,
				},
			},
		});
		const service = new ConferenceModerationService(client);

		await service.moderate(MODERATOR, CONFERENCE_ID, "mute", { memberRef: LEG });

		expect(asked).to.deep.equal(["engine-a", "engine-b"]);
	});

	/**
	 * The distinction the whole protocol rests on. A `media-refused` comes from the instance that
	 * ACTUALLY holds the member; sending the command on to a neighbour would get a cheerful "not
	 * mine" and turn a real media failure into a 404 the operator cannot act on.
	 */
	it("stops at a real refusal instead of shopping it to the next instance", async () => {
		const { client, asked } = fakeClient({
			claim: claimWith({ "engine-a": NOW + 30_000, "engine-b": NOW + 30_000 }),
			answers: { "engine-a": refusal("engine-a", "media-refused") },
		});
		const service = new ConferenceModerationService(client);

		const body = await failure(
			service.moderate(MODERATOR, CONFERENCE_ID, "mute", { memberRef: LEG }),
		);

		expect(asked).to.deep.equal(["engine-a"]);
		expect(body["code"]).to.equal("CONFERENCE_CONTROL_UNAVAILABLE");
	});

	/**
	 * An expired contribution is an instance that stopped heartbeating — it has crashed, its seats no
	 * longer count, and asking it costs a person a full request timeout.
	 */
	it("skips an instance whose contribution has expired", async () => {
		const { client, asked } = fakeClient({
			claim: claimWith({ "engine-a": NOW - 1, "engine-b": NOW + 30_000 }),
			answers: {
				"engine-b": {
					ok: true,
					action: "kick",
					instanceId: "engine-b",
					memberCount: 1,
					memberRef: LEG,
				},
			},
		});
		const service = new ConferenceModerationService(client);

		await service.moderate(MODERATOR, CONFERENCE_ID, "kick", { memberRef: LEG });

		expect(asked).to.deep.equal(["engine-b"]);
	});

	/** Only after EVERY contributor has said so is "that participant is gone" a fact. */
	it("answers member-not-found only when the whole list is exhausted", async () => {
		const { client, asked } = fakeClient({
			claim: claimWith({ "engine-a": NOW + 30_000, "engine-b": NOW + 30_000 }),
		});
		const service = new ConferenceModerationService(client);

		const body = await failure(
			service.moderate(MODERATOR, CONFERENCE_ID, "mute", { memberRef: LEG }),
		);

		expect(asked).to.deep.equal(["engine-a", "engine-b"]);
		expect(body["code"]).to.equal("CONFERENCE_MEMBER_NOT_FOUND");
	});
});

describe("a room nobody is in", () => {
	/**
	 * A 404 rather than a fan-out, which is what having the claim buys: a command on a room nobody
	 * has joined would otherwise be N requests to engines that have never heard of it.
	 */
	it("is a 404 that says the meeting is not running, not that the room does not exist", async () => {
		const { client, asked } = fakeClient({});
		const service = new ConferenceModerationService(client);

		const body = await failure(service.moderate(MODERATOR, CONFERENCE_ID, "lock"));

		expect(body["code"]).to.equal("CONFERENCE_NOT_RUNNING");
		expect(asked).to.deep.equal([]);
	});

	/**
	 * "Nobody is in the room" and "the platform cannot answer" need opposite reactions, and both look
	 * like an absent claim from here.
	 */
	it("is a 503 when the broker is what is missing", async () => {
		const { client } = fakeClient({ ready: false });
		const service = new ConferenceModerationService(client);

		const body = await failure(service.moderate(MODERATOR, CONFERENCE_ID, "lock"));

		expect(body["code"]).to.equal("CONFERENCE_CONTROL_UNAVAILABLE");
	});
});

describe("actions this platform cannot serve", () => {
	/**
	 * 501 and not 400: the request is well formed and the platform cannot do it, which is the one
	 * status a client can use to HIDE the control rather than retry it.
	 */
	it("turns a not-servable refusal into a 501 naming the action", async () => {
		const { client } = fakeClient({
			claim: claimWith({ "engine-a": NOW + 30_000 }),
			answers: {
				"engine-a": {
					ok: false,
					action: "volume",
					instanceId: "engine-a",
					memberCount: 2,
					reason: "not-servable",
					error: "no media plane on this platform can re-level one conference participant",
				},
			},
		});
		const service = new ConferenceModerationService(client);

		const body = await failure(
			service.moderate(MODERATOR, CONFERENCE_ID, "volume", { memberRef: LEG, gainPercent: 50 }),
		);

		expect(body["code"]).to.equal("CONFERENCE_ACTION_NOT_SERVABLE");
		expect(body["action"]).to.equal("volume");
	});
});

describe("the request this service builds", () => {
	it("satisfies the contract the engine was generated from", async () => {
		const { client, sent } = fakeClient({ claim: claimWith({ "engine-a": NOW + 30_000 }) });
		const service = new ConferenceModerationService(client);

		await failure(
			service.moderate(MODERATOR, CONFERENCE_ID, "volume", {
				memberRef: LEG,
				gainPercent: 250,
				gainScope: "talk",
			}),
		);

		expect(sent).to.have.length(1);
		expect(() => conferenceControlRequestSchema.parse(sent[0])).to.not.throw();
	});

	/** Who did it, for the audit trail and for the `conference.participant.updated` event. */
	it("stamps the acting user", async () => {
		const { client, sent } = fakeClient({ claim: claimWith({ "engine-a": NOW + 30_000 }) });
		const service = new ConferenceModerationService(client);

		await failure(service.moderate(MODERATOR, CONFERENCE_ID, "kick", { memberRef: LEG }));

		expect(sent[0]?.byUserId).to.equal(USER_ID);
	});
});

describe("the moderation DTOs", () => {
	/**
	 * The ACTION is in the path and the PARTICIPANT is in the path, so a body that names either is a
	 * value the caller believes they sent and the server would silently drop.
	 */
	it("refuses a body on an action that takes none", () => {
		expect(() => emptyConferenceModerationDto.parse({ direction: "out" })).to.throw();
		expect(() => emptyConferenceModerationDto.parse({})).to.not.throw();
	});

	it("bounds a level at four times unity, past which a member is clipping rather than louder", () => {
		expect(() => setConferenceVolumeDto.parse({ gainPercent: 400 })).to.not.throw();
		expect(() => setConferenceVolumeDto.parse({ gainPercent: 401 })).to.throw();
		expect(() => setConferenceVolumeDto.parse({ gainPercent: -1 })).to.throw();
	});

	it("takes a scope, because one slider means both halves", () => {
		expect(setConferenceVolumeDto.parse({ gainPercent: 50 }).scope).to.equal(undefined);
		expect(setConferenceVolumeDto.parse({ gainPercent: 50, scope: "talk" }).scope).to.equal("talk");
	});
});
