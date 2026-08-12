import { isMappingError, toRuntimeVerb, toWireResult } from "./session-verb-mapping";
import type { SessionVerbOutcome } from "../nats/session-verb.service";
import type {
	SessionAnnounceRequest,
	SessionAnnounceResponse,
	SessionVerbRefusalReason,
	SessionVerbRequest,
} from "@optimiq-voice/events";
import type { HangupCause, Verb, VerbResult } from "@optimiq-voice/telephony";

/**
 * The engine's half of the session protocol: the calls this instance has handed to an application,
 * and the verbs that come back for them.
 *
 * ## What this owns, and what it deliberately does not
 *
 * It owns the SESSION — the fact that leg X is under application Y's control until further notice,
 * and the promise the plan walker is parked on while that is true. It owns nothing about media: a
 * verb arrives, is translated, and is handed to the same {@link VerbExecutor} the plan walker uses.
 * That reuse is the whole reason the session protocol is small: the executor already guards, already
 * refuses a leg that is tearing down, and already routes a `dial` through the toll gate, so an
 * application gets exactly the same treatment a dial plan does.
 *
 * ## The walk BLOCKS, and that is the design
 *
 * `run` does not return until the session ends. The plan walker is a coroutine over one leg, and an
 * `application` destination means "somebody else drives from here" — so the node awaits, exactly the
 * way `queueNode` awaits a queue session. Returning immediately and letting the walk fall through
 * would run the destination's failover path while the application was still talking to the caller.
 *
 * ## Three ways a session ends, and a fourth that is a backstop
 *
 * 1. The application sends `hangup`. The normal ending, and the only one it controls.
 * 2. The leg goes away — the caller hung up, or the media server dropped it. The orchestrator tells
 *    us through {@link ApplicationSessions.legEnded}.
 * 3. The application's socket closes. The CONTROL PLANE is responsible for this one: it sends a
 *    `hangup` on the session's behalf, because it is the only party that can see a socket close.
 * 4. {@link ApplicationSessionSettings.maxSessionMs}. A backstop, not a feature. If the control
 *    plane crashed between (3) and its `hangup`, nothing else in this list will ever fire and the
 *    caller is holding a live line to a process that has forgotten them. Four hours is longer than
 *    any real call and short enough that the leg does not outlive the shift.
 *
 * A session HEARTBEAT — the control plane periodically renewing each session, with the engine
 * reaping what stops renewing — is the honest version of (4) and is deliberately not in this wave.
 * The seam is {@link ApplicationSessionSettings.maxSessionMs}: a renewal would move that deadline
 * forward, and nothing else here would change.
 */

/** One leg, as the session runtime needs to see it. Supplied by the orchestrator. */
export interface ApplicationLeg {
	readonly legId: string;
	readonly callId: string;
	readonly organizationId: string;
	readonly isAnswered: boolean;
	readonly callerIdNumber?: string;
	readonly callerIdName?: string;
}

/** What the walker asks for when a call reaches an `application` destination. */
export interface ApplicationRunRequest {
	readonly application: string;
	readonly leg: ApplicationLeg;
	readonly direction: SessionAnnounceRequest["direction"];
	readonly dialedNumber?: string;
	readonly arguments?: Readonly<Record<string, string>>;
}

/** How a session ended, in the vocabulary the walker turns into a `StepResult`. */
export type ApplicationOutcome =
	| {
			/** Nobody took the call. The walker announces — never dead air. */
			readonly kind: "unavailable";
			readonly reason: string;
	  }
	| { readonly kind: "hangup"; readonly cause: HangupCause; readonly sessionId: string }
	/** The leg went away underneath the application. Nothing left to walk. */
	| { readonly kind: "aborted"; readonly sessionId: string };

export interface ApplicationSessionSettings {
	/** The backstop deadline. See the note on this file. */
	readonly maxSessionMs: number;
}

export const DEFAULT_APPLICATION_SESSION_SETTINGS: ApplicationSessionSettings = {
	maxSessionMs: 4 * 60 * 60 * 1_000,
};

/** How one verb went, before the responder stamps the instance on it. */
export type VerbDispatchOutcome =
	| { readonly ok: true; readonly result: VerbResult }
	| {
			readonly ok: false;
			readonly reason: Extract<
				SessionVerbRefusalReason,
				"not-permitted" | "unsupported" | "internal"
			>;
			readonly error: string;
	  };

export interface ApplicationSessionDependencies {
	/** Offers a call to the control plane. */
	announce(request: SessionAnnounceRequest): Promise<SessionAnnounceResponse>;
	/** Runs one verb on one leg, through the engine's own executor. */
	execute(legId: string, verb: Verb): Promise<VerbDispatchOutcome>;
	/** This engine's id — the address the control plane sends verbs back to. */
	readonly instanceId: string;
	readonly settings?: Partial<ApplicationSessionSettings>;
	readonly now?: () => number;
	/** Injected so a spec asserts the backstop without waiting four hours for it. */
	readonly setTimer?: (fn: () => void, ms: number) => { readonly cancel: () => void };
	readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

interface LiveSession {
	readonly sessionId: string;
	readonly legId: string;
	readonly callId: string;
	readonly orgId: string;
	readonly application: string;
	readonly startedAtMs: number;
	readonly settle: (outcome: ApplicationOutcome) => void;
	readonly timer: { readonly cancel: () => void };
}

export class ApplicationSessions {
	private readonly settings: ApplicationSessionSettings;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => { readonly cancel: () => void };
	private readonly log: (message: string, detail?: Record<string, unknown>) => void;

	/** Keyed by SESSION id — the handle the control plane holds. */
	private readonly sessions = new Map<string, LiveSession>();
	/** Keyed by DOMAIN leg id, so a leg ending can find its session in one step. */
	private readonly byLeg = new Map<string, LiveSession>();

	constructor(private readonly deps: ApplicationSessionDependencies) {
		this.settings = { ...DEFAULT_APPLICATION_SESSION_SETTINGS, ...deps.settings };
		this.now = deps.now ?? Date.now;
		this.log = deps.log ?? (() => undefined);
		this.setTimer =
			deps.setTimer ??
			((fn, ms) => {
				const timer = setTimeout(fn, ms);
				timer.unref?.();
				return { cancel: () => clearTimeout(timer) };
			});
	}

	/** Sessions this instance is holding. `/healthz` and the specs read it. */
	get activeSessionCount(): number {
		return this.sessions.size;
	}

	/**
	 * Offers the call to an application and waits for the session to end.
	 *
	 * The refusal path is the one worth reading: EVERY way this can fail to hand the call over
	 * produces `unavailable` with a reason, because the walker's only sane response to all of them
	 * is the same announcement. A destination that threw here would produce a caller listening to
	 * silence, which is precisely the outcome the `application` node existed to avoid while it was
	 * a stub.
	 */
	async run(request: ApplicationRunRequest): Promise<ApplicationOutcome> {
		const announcement: SessionAnnounceRequest = {
			orgId: request.leg.organizationId,
			application: request.application,
			callId: request.leg.callId,
			legId: request.leg.legId,
			instanceId: this.deps.instanceId,
			direction: request.direction,
			answered: request.leg.isAnswered,
			...(request.leg.callerIdNumber === undefined
				? {}
				: { callerIdNumber: request.leg.callerIdNumber }),
			...(request.leg.callerIdName === undefined ? {} : { callerIdName: request.leg.callerIdName }),
			...(request.dialedNumber === undefined ? {} : { dialedNumber: request.dialedNumber }),
			...(request.arguments === undefined ? {} : { arguments: { ...request.arguments } }),
			at: new Date(this.now()).toISOString(),
		};

		let response: SessionAnnounceResponse;
		try {
			response = await this.deps.announce(announcement);
		} catch (error) {
			return { kind: "unavailable", reason: String(error) };
		}
		const sessionId = response.sessionId;
		if (!response.accepted || sessionId === undefined) {
			return {
				kind: "unavailable",
				reason: response.error ?? response.reason ?? "no application took the call",
			};
		}
		if (this.byLeg.has(request.leg.legId)) {
			// One leg, one session. A second would mean two applications sending verbs at the same
			// channel with no ordering between them, which is a race nobody can debug from a socket.
			return { kind: "unavailable", reason: "this leg is already under an application's control" };
		}

		return await new Promise<ApplicationOutcome>((resolve) => {
			let settled = false;
			const settle = (outcome: ApplicationOutcome): void => {
				if (settled) {
					return;
				}
				settled = true;
				const held = this.sessions.get(sessionId);
				held?.timer.cancel();
				this.sessions.delete(sessionId);
				this.byLeg.delete(request.leg.legId);
				resolve(outcome);
			};
			const timer = this.setTimer(() => {
				this.log("an application session hit its backstop deadline and was ended", {
					sessionId,
					legId: request.leg.legId,
					application: request.application,
				});
				settle({ kind: "hangup", cause: "ALLOTTED_TIMEOUT", sessionId });
			}, this.settings.maxSessionMs);

			const session: LiveSession = {
				sessionId,
				legId: request.leg.legId,
				callId: request.leg.callId,
				orgId: request.leg.organizationId,
				application: request.application,
				startedAtMs: this.now(),
				settle,
				timer,
			};
			this.sessions.set(sessionId, session);
			this.byLeg.set(request.leg.legId, session);
		});
	}

	/**
	 * Runs one verb from the control plane.
	 *
	 * The order of the checks is the authorization: session exists → session names THIS leg → the
	 * leg belongs to the same organization → translate → execute. The org comparison is against the
	 * session the engine minted, never against the request, which is what stops a caller who has one
	 * valid session id from sending verbs at another tenant's call by naming its leg.
	 */
	async execute(request: SessionVerbRequest): Promise<SessionVerbOutcome> {
		const session = this.sessions.get(request.sessionId);
		if (session === undefined) {
			return refuse(request.verb, "unknown-leg", "no live session with that id on this engine");
		}
		if (session.legId !== request.legId || session.orgId !== request.orgId) {
			// Deliberately one refusal for both, and deliberately not "the leg exists but is not
			// yours": an application that could tell those apart could enumerate another tenant's live
			// legs one guess at a time.
			return refuse(
				request.verb,
				"session-mismatch",
				"the session does not name that leg in that organization",
			);
		}

		const mapped = toRuntimeVerb(request);
		if (isMappingError(mapped)) {
			return refuse(request.verb, "bad_request", mapped.error);
		}

		const outcome = await this.deps.execute(session.legId, mapped.verb);
		if (!outcome.ok) {
			return refuse(request.verb, outcome.reason, outcome.error);
		}

		if (request.verb === "hangup") {
			// The application ended the call. The walk it has been holding resumes here, with the cause
			// the application chose, so the CDR says what happened rather than `NORMAL_CLEARING` by
			// default.
			session.settle({
				kind: "hangup",
				cause: (request.arguments?.cause as HangupCause | undefined) ?? "NORMAL_CLEARING",
				sessionId: session.sessionId,
			});
		}

		return { ok: true, ...toWireResult(request.verb, outcome.result) };
	}

	/**
	 * The leg went away. Called by the orchestrator on teardown, BEFORE the CDR is written.
	 *
	 * Idempotent and silent when there is no session: most legs on this engine are not under an
	 * application's control, and a teardown path that had to ask first would be a lookup on every
	 * hangup in the system.
	 */
	legEnded(legId: string): void {
		const session = this.byLeg.get(legId);
		if (session === undefined) {
			return;
		}
		this.log("an application session ended because its leg did", {
			sessionId: session.sessionId,
			legId,
			application: session.application,
			durationMs: Math.max(0, this.now() - session.startedAtMs),
		});
		session.settle({ kind: "aborted", sessionId: session.sessionId });
	}

	/** Ends every session this instance holds. The shutdown path. */
	clear(): void {
		// oxlint-disable-next-line unicorn/no-useless-spread -- `settle` deletes from this map
		for (const session of [...this.sessions.values()]) {
			session.settle({ kind: "aborted", sessionId: session.sessionId });
		}
	}
}

function refuse(
	verb: SessionVerbRequest["verb"],
	reason: SessionVerbRefusalReason,
	error: string,
): SessionVerbOutcome {
	return { ok: false, verb, reason, error: error.slice(0, 512) };
}
