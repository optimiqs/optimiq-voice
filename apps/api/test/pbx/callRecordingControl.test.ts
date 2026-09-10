import { Reflector } from "@nestjs/core";
import { expect } from "chai";
import { APP_SESSION_REQUEST_KEY } from "../../src/auth/app-session";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import { RequirePermissionsGuard } from "../../src/auth/require-permissions.guard";
import { CallRecordingService } from "../../src/pbx/calls/call-recording.service";
import { CallsController } from "../../src/pbx/calls/calls.controller";
import { emptyCallControlDto } from "../../src/pbx/calls/calls.dto";
import { ControlledCalls } from "../../src/pbx/calls/controlled-calls";
import type { AuthService, ResolvedAccess } from "../../src/auth/auth.service";
import type { OrganizationSuspensionService } from "../../src/auth/organization-suspension.service";
import type { CallControlClient } from "../../src/pbx/calls/call-control.client";
import type { ExecutionContext, HttpException } from "@nestjs/common";
import type { AppSession, Permission } from "@optimiq-voice/auth";
import type {
	CallControlRequest,
	CallControlResponse,
	SessionVerbName,
	SessionVerbResponse,
} from "@optimiq-voice/events/schemas";

/**
 * `POST /api/v1/calls/:id/recording/{pause,resume}` — the PCI pause, minus the broker.
 *
 * Four things are worth proving without a live call. That the routes are behind `calls.control` and
 * that a caller who holds every recording grant and not that one is refused — the permission is the
 * whole reason this is not `recordings.configure`. That the tenant scoping is the lookup, so a call
 * id belonging to another organization is indistinguishable from one that never existed. That the
 * verb which reaches the engine is `pauseRecord` for a pause and `resumeRecord` for a resume, on the
 * leg the session named and never on one the caller did. And that every refusal in the session
 * contract's vocabulary lands on a status an agent's console can act on: hide the control, say the
 * call is gone, or refuse to let a card number be read.
 *
 * And then the same four things again for the OTHER transport. A call under an application's
 * control goes over `session-verb`; a softphone, desk-phone or queue call — which is where a PCI
 * pause is actually pressed — has no session and goes over `rpc.engine.v1.call-control`. The
 * property that matters across the two is that a client cannot tell which one carried its request
 * except by the refusal reason, and that the registry decides, so one recorder never has two
 * commanders.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORG = "019fd3c2-aaaa-76be-a6b3-b0f1914e39b6";
const USER = "019fd3c2-9999-76be-a6b3-b0f1914e39b6";
const CALL = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const LEG = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";

function sessionFor(organizationId = ORG): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: organizationId,
		},
		user: { id: USER, email: "u@test", name: "U", emailVerified: true },
	} as AppSession;
}

/** Records every verb it is asked for, and answers whatever the test set. */
function registerCall(
	controlled: ControlledCalls,
	answer: SessionVerbResponse | (() => SessionVerbResponse),
	organizationId = ORG,
): { readonly sent: SessionVerbName[]; readonly release: () => void } {
	const sent: SessionVerbName[] = [];
	const release = controlled.register({
		organizationId,
		callId: CALL,
		legId: LEG,
		application: "payments",
		sendVerb: async (verb) => {
			sent.push(verb);
			return typeof answer === "function" ? answer() : answer;
		},
	});
	return { sent, release };
}

function ok(verb: SessionVerbName): SessionVerbResponse {
	return { ok: true, verb, instanceId: "engine-1", endReason: "completed" };
}

function refusal(
	verb: SessionVerbName,
	reason: NonNullable<SessionVerbResponse["reason"]>,
): SessionVerbResponse {
	return { ok: false, verb, instanceId: "engine-1", reason, error: `refused: ${reason}` };
}

async function statusOf(run: () => Promise<unknown>): Promise<number> {
	try {
		await run();
	} catch (error) {
		return (error as HttpException).getStatus();
	}
	throw new Error("expected the call to throw");
}

async function bodyOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
	try {
		await run();
	} catch (error) {
		return (error as HttpException).getResponse() as Record<string, unknown>;
	}
	throw new Error("expected the call to throw");
}

describe("the recording pause routes' authorization", () => {
	/**
	 * The guard over the REAL decorator metadata of the real handler, on the `sipAclEntries.test.ts`
	 * pattern: a test that redefined the metadata would pass with the decorator deleted.
	 */
	function guardFor(
		handler: (...args: never[]) => unknown,
		permissions: readonly string[],
	): { guard: RequirePermissionsGuard; context: ExecutionContext } {
		const request: Record<string, unknown> = { [APP_SESSION_REQUEST_KEY]: sessionFor() };
		const context = {
			getHandler: () => handler,
			getClass: () => CallsController,
			switchToHttp: () => ({ getRequest: () => request }),
		} as unknown as ExecutionContext;
		const access: ResolvedAccess = {
			organizationId: ORG,
			role: "member",
			permissions: permissions as Permission[],
		};
		const authService = { resolveAccess: async () => access } as unknown as AuthService;
		const suspension = {
			isSuspended: async () => false,
		} as unknown as OrganizationSuspensionService;
		return {
			guard: new RequirePermissionsGuard(new Reflector(), authService, suspension),
			context,
		};
	}

	it("declares `calls.control` on both routes, and not a recordings grant", () => {
		for (const handler of [
			CallsController.prototype.pauseRecording,
			CallsController.prototype.resumeRecording,
		]) {
			expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA, handler)).to.deep.equal([
				"calls.control",
			]);
		}
	});

	it("refuses a caller holding every recordings grant and not `calls.control`", async () => {
		// The exact caller the permission choice is about: somebody who administers the recording
		// POLICY has no business reaching inside a live call, and the route must not let the two be
		// confused because both sentences contain the word "recording".
		const { guard, context } = guardFor(CallsController.prototype.pauseRecording, [
			"recordings.read",
			"recordings.download",
			"recordings.delete",
			"recordings.configure",
		]);
		let refused = false;
		try {
			await guard.canActivate(context);
		} catch {
			refused = true;
		}
		expect(refused).to.equal(true);
	});

	it("admits a caller holding `calls.control`", async () => {
		const { guard, context } = guardFor(CallsController.prototype.resumeRecording, [
			"calls.control",
		]);
		expect(await guard.canActivate(context)).to.equal(true);
	});
});

describe("pausing and resuming a live recording", () => {
	it("sends `pauseRecord` for a pause and `resumeRecord` for a resume, on the session's leg", async () => {
		const controlled = new ControlledCalls();
		const { sent } = registerCall(controlled, () => ok("pauseRecord"));
		const service = new CallRecordingService(controlled);

		const paused = await service.setPaused(sessionFor(), CALL, true);
		const resumed = await service.setPaused(sessionFor(), CALL, false);

		expect(sent).to.deep.equal(["pauseRecord", "resumeRecord"]);
		expect(paused).to.deep.equal({
			callId: CALL,
			legId: LEG,
			paused: true,
			instanceId: "engine-1",
		});
		expect(resumed.paused).to.equal(false);
	});

	it("cannot be aimed at another tenant's call, and cannot tell one from a call that never was", async () => {
		const controlled = new ControlledCalls();
		const { sent } = registerCall(controlled, () => ok("pauseRecord"), OTHER_ORG);
		const service = new CallRecordingService(controlled);

		const foreign = await bodyOf(async () => await service.setPaused(sessionFor(), CALL, true));
		const missing = await bodyOf(
			async () => await service.setPaused(sessionFor(), "no-such-call", true),
		);

		expect(foreign.code).to.equal("CALL_NOT_CONTROLLABLE");
		expect(foreign.statusCode).to.equal(404);
		expect(missing.code).to.equal("CALL_NOT_CONTROLLABLE");
		// Nothing was asked of the engine, which is the half a status code cannot show.
		expect(sent).to.deep.equal([]);
	});

	it("maps every refusal in the contract onto a status the console can act on", async () => {
		const expected: ReadonlyArray<[NonNullable<SessionVerbResponse["reason"]>, number]> = [
			["bad_request", 409],
			["unknown-leg", 409],
			["session-mismatch", 409],
			["not-permitted", 409],
			// 501 so a console HIDES the control rather than retrying it: ARI's pause shortens the
			// file, so on that media plane the operation does not exist rather than having failed.
			["unsupported", 501],
			// Both mean the recording is in the state it was already in, which is the promise an agent
			// about to read a card number depends on.
			["shutting-down", 503],
			["internal", 503],
		];
		for (const [reason, status] of expected) {
			const controlled = new ControlledCalls();
			registerCall(controlled, () => refusal("pauseRecord", reason));
			const service = new CallRecordingService(controlled);
			expect(
				await statusOf(async () => await service.setPaused(sessionFor(), CALL, true)),
				reason,
			).to.equal(status);
		}
	});

	it("carries the engine's reason in the body, so a client switches on a string", async () => {
		const controlled = new ControlledCalls();
		registerCall(controlled, () => refusal("pauseRecord", "not-permitted"));
		const service = new CallRecordingService(controlled);
		const body = await bodyOf(async () => await service.setPaused(sessionFor(), CALL, true));
		expect(body.code).to.equal("CALL_RECORDING_NOT_PAUSABLE");
		expect(body.reason).to.equal("not-permitted");
		expect(body.detail).to.equal("refused: not-permitted");
	});
});

/** A `CallControlClient` made of two arrays. No broker, no bucket. */
function fakeEngine(
	owners: readonly string[],
	answer: (instanceId: string, request: CallControlRequest) => CallControlResponse,
): {
	readonly client: CallControlClient;
	readonly sent: { instanceId: string; request: CallControlRequest }[];
	readonly lookups: { organizationId: string; callId: string }[];
} {
	const sent: { instanceId: string; request: CallControlRequest }[] = [];
	const lookups: { organizationId: string; callId: string }[] = [];
	const client = {
		ownersOf: async (organizationId: string, callId: string) => {
			lookups.push({ organizationId, callId });
			return owners;
		},
		send: async (instanceId: string, request: CallControlRequest) => {
			sent.push({ instanceId, request });
			return answer(instanceId, request);
		},
	} as unknown as CallControlClient;
	return { client, sent, lookups };
}

function engineOk(
	verb: CallControlRequest["verb"],
	paused: boolean,
	instanceId = "engine-1",
): CallControlResponse {
	return { ok: true, verb, instanceId, legId: LEG, recording: true, paused };
}

function engineRefusal(
	verb: CallControlRequest["verb"],
	reason: NonNullable<CallControlResponse["reason"]>,
	instanceId = "engine-1",
): CallControlResponse {
	return { ok: false, verb, instanceId, reason, error: `refused: ${reason}` };
}

describe("pausing a call no application is driving", () => {
	it("goes to the engine that owns the call, with the operator as the actor", async () => {
		const engine = fakeEngine(["engine-7"], (_id, request) => engineOk(request.verb, true));
		const service = new CallRecordingService(new ControlledCalls(), engine.client);

		const paused = await service.setPaused(sessionFor(), CALL, true);

		expect(engine.lookups).to.deep.equal([{ organizationId: ORG, callId: CALL }]);
		expect(engine.sent).to.have.length(1);
		expect(engine.sent[0]?.instanceId).to.equal("engine-7");
		expect(engine.sent[0]?.request).to.deep.equal({
			orgId: ORG,
			callId: CALL,
			verb: "pauseRecord",
			byUserId: USER,
		});
		// No `legId` on the wire: the control plane has the CALL, and inventing a leg would be the
		// api guessing at the engine's own registry.
		expect(engine.sent[0]?.request.legId).to.equal(undefined);
		expect(paused).to.deep.equal({
			callId: CALL,
			legId: LEG,
			paused: true,
			instanceId: "engine-1",
		});
	});

	it("reports what the RECORDER is doing, not what was asked", async () => {
		// A resume that landed on a recorder already running must say so: the button is drawn from
		// this, and a button that disagrees with the recorder is the one bug this control cannot have.
		const engine = fakeEngine(["engine-1"], (_id, request) => engineOk(request.verb, true));
		const service = new CallRecordingService(new ControlledCalls(), engine.client);

		expect((await service.setPaused(sessionFor(), CALL, false)).paused).to.equal(true);
	});

	it("prefers the session when one holds the call, so one recorder never has two commanders", async () => {
		const controlled = new ControlledCalls();
		const { sent } = registerCall(controlled, () => ok("pauseRecord"));
		const engine = fakeEngine(["engine-1"], (_id, request) => engineOk(request.verb, true));
		const service = new CallRecordingService(controlled, engine.client);

		await service.setPaused(sessionFor(), CALL, true);

		expect(sent).to.deep.equal(["pauseRecord"]);
		expect(engine.lookups).to.deep.equal([]);
		expect(engine.sent).to.deep.equal([]);
	});

	it("answers a call nothing live holds exactly as one that never existed", async () => {
		const engine = fakeEngine([], () => engineOk("pauseRecord", true));
		const service = new CallRecordingService(new ControlledCalls(), engine.client);

		const body = await bodyOf(async () => await service.setPaused(sessionFor(), CALL, true));

		expect(body.code).to.equal("CALL_NOT_CONTROLLABLE");
		expect(body.statusCode).to.equal(404);
		expect(engine.sent).to.deep.equal([]);
	});

	it("looks the call up under the CALLER's organization and never one from a payload", async () => {
		// The tenancy check IS the lookup, on both transports. The engine re-checks the org against
		// the leg it holds, so a key range for another tenant finds nothing there either.
		const engine = fakeEngine(["engine-1"], (_id, request) =>
			engineRefusal(request.verb, "unknown-call"),
		);
		const service = new CallRecordingService(new ControlledCalls(), engine.client);

		const body = await bodyOf(
			async () => await service.setPaused(sessionFor(OTHER_ORG), CALL, true),
		);

		expect(engine.lookups).to.deep.equal([{ organizationId: OTHER_ORG, callId: CALL }]);
		expect(engine.sent[0]?.request.orgId).to.equal(OTHER_ORG);
		expect(body.code).to.equal("CALL_NOT_CONTROLLABLE");
	});

	it("re-addresses on a stale channels entry, and stops on any other refusal", async () => {
		const stale = fakeEngine(["engine-a", "engine-b"], (instanceId, request) =>
			instanceId === "engine-a"
				? engineRefusal(request.verb, "wrong_instance", instanceId)
				: engineOk(request.verb, true, instanceId),
		);
		const service = new CallRecordingService(new ControlledCalls(), stale.client);
		expect((await service.setPaused(sessionFor(), CALL, true)).instanceId).to.equal("engine-b");
		expect(stale.sent.map((entry) => entry.instanceId)).to.deep.equal(["engine-a", "engine-b"]);

		// Every other refusal is a fact about the CALL, which the next instance would only repeat.
		const settled = fakeEngine(["engine-a", "engine-b"], (instanceId, request) =>
			engineRefusal(request.verb, "not-recording", instanceId),
		);
		const second = new CallRecordingService(new ControlledCalls(), settled.client);
		await statusOf(async () => await second.setPaused(sessionFor(), CALL, true));
		expect(settled.sent).to.have.length(1);
	});

	it("maps every engine refusal onto a status the console can act on", async () => {
		const expected: ReadonlyArray<[NonNullable<CallControlResponse["reason"]>, number]> = [
			["bad_request", 409],
			// The call is reachable and nothing is recording: the control should stay and say so.
			["not-recording", 409],
			["media-refused", 409],
			// The call went away, or is mid-failover with no instance left to ask. Both are "there is
			// no recording control here right now", which is what the 404 says.
			["unknown-call", 404],
			["wrong_instance", 404],
			// 501 so a console HIDES the control: on the ARI driver the operation does not exist.
			["unsupported", 501],
			["shutting-down", 503],
			["internal", 503],
		];
		for (const [reason, status] of expected) {
			const engine = fakeEngine(["engine-1"], (_id, request) =>
				engineRefusal(request.verb, reason),
			);
			const service = new CallRecordingService(new ControlledCalls(), engine.client);
			expect(
				await statusOf(async () => await service.setPaused(sessionFor(), CALL, true)),
				reason,
			).to.equal(status);
		}
	});

	it("refuses rather than pretending when no engine subject is configured", async () => {
		// A deployment with no broker. `CALL_NOT_CONTROLLABLE` and not a 200: a pause nobody applied
		// is worse than one that failed, because an agent reads a card number into the difference.
		const service = new CallRecordingService(new ControlledCalls());
		const body = await bodyOf(async () => await service.setPaused(sessionFor(), CALL, true));
		expect(body.code).to.equal("CALL_NOT_CONTROLLABLE");
	});
});

describe("the controlled-call registry", () => {
	it("stops answering once the session releases it, and releases only once", () => {
		const controlled = new ControlledCalls();
		const { release } = registerCall(controlled, () => ok("pauseRecord"));
		expect(controlled.find(ORG, CALL)?.legId).to.equal(LEG);

		release();
		expect(controlled.find(ORG, CALL)).to.equal(undefined);
		expect(controlled.size).to.equal(0);

		// A second session on the same call id, then the FIRST one's release firing again: the entry
		// must survive, because a teardown that ran twice would otherwise take the live one with it.
		const second = registerCall(controlled, () => ok("pauseRecord"));
		release();
		expect(controlled.find(ORG, CALL)).to.not.equal(undefined);
		second.release();
		expect(controlled.size).to.equal(0);
	});
});

describe("the recording-control request body", () => {
	it("takes nothing, so a state a caller believes they sent cannot be dropped", () => {
		expect(emptyCallControlDto.safeParse({}).success).to.equal(true);
		expect(emptyCallControlDto.safeParse({ paused: false }).success).to.equal(false);
	});
});
