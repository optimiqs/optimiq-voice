import { z } from "zod/v4";
import { SESSION_VERBS, sessionVerbArgumentsSchema } from "@optimiq-voice/events/schemas";

/**
 * The `/api/v1/session` wire protocol — the session protocol's client half.
 *
 * ## Shape
 *
 * ```
 * client -> server                          server -> client
 * ---------------------------------------   ------------------------------------------------------
 * {op:"claim", application, id?}            {op:"welcome", orgId, heartbeatMs, at}
 * {op:"release", application, id?}          {op:"claimed", applications:[…], denied:[…], id?}
 * {op:"verb", sessionId, verb, args?, id?}  {op:"released", applications:[…], id?}
 * {op:"ping", id?}                          {op:"session.started", sessionId, callId, legId, …}
 *                                           {op:"session.ended", sessionId, callId, reason, at}
 *                                           {op:"result", sessionId, ok, verb, …, id?}
 *                                           {op:"event", sessionId, callId, type, at, data}
 *                                           {op:"pong", at, id?}
 *                                           {op:"error", code, message, id?}
 * ```
 *
 * ## Why this is a second protocol and not a topic on `/api/v1/live`
 *
 * They look adjacent — both are authenticated WebSockets carrying call activity — and they are
 * opposites. `/api/v1/live` is a READ: it fans a tenant's state out to browsers, every frame flows
 * one way, and a client that stops reading loses nothing but freshness. This one is a CONTROL
 * channel: frames flow both ways, each `verb` is a request with an answer, and a socket that stops
 * reading has a caller on the other end of it listening to silence. Putting a write surface behind a
 * topic subscription would also have meant one permission gating both, and `live-topics.ts` already
 * settled that the live feed rides `cdr.read` — which is emphatically not the grant that should let
 * somebody hang a call up.
 *
 * What they DO share is deliberate and is the reason this file reads like `live-protocol.ts`: the
 * upgrade authentication, the origin check, the heartbeat and the periodic session revalidation are
 * the same code path and the same reasoning. See `session-gateway.ts`.
 *
 * ## Verbs are requests, and `id` is how an application tells the answers apart
 *
 * A `verb` frame may carry an opaque `id`, echoed on the `result`. It is optional because a simple
 * application sends one verb at a time and reads the next frame; it exists because a real one
 * pipelines — starting a recording while a prompt plays — and the two `result` frames are otherwise
 * distinguishable only by their verb name, which is not enough when both say `play`.
 *
 * ## Events are the CALL's events, not a parallel family
 *
 * Everything under `{op:"event"}` is a `calls.evt.v1` envelope, relayed verbatim with the session id
 * attached. There is no second event vocabulary for applications to learn, and no second publisher
 * for the engine to keep in step: an integration watching `channel.answered` is watching exactly the
 * event the CDR writer and the webhook dispatcher watch. The only frames this protocol invents are
 * the two the call events cannot express, because they are about the SESSION rather than the call —
 * `session.started` (this call is yours now) and `session.ended` (it is not any more).
 */

/** Server → client ping interval. Comfortably inside the 60 s idle timeout of most proxies. */
export const SESSION_HEARTBEAT_MS = 25_000;

/** A socket that has not answered two heartbeats is gone, whatever TCP believes. */
export const SESSION_HEARTBEAT_TIMEOUT_MS = SESSION_HEARTBEAT_MS * 2 + 5_000;

/** The path the gateway is mounted on. */
export const SESSION_PATH = "/api/v1/session";

/**
 * Per-connection application ceiling.
 *
 * Each claim opens a NATS subscription, so an unbounded claim list is a way for one authenticated
 * socket to make the server hold N of them. Eight is more integrations than any single application
 * process legitimately is — a fleet that needs more runs more processes, which is also how it gets
 * the redundancy it should already want.
 */
export const SESSION_MAX_APPLICATIONS = 8;

/** Frames larger than this are a client that is not speaking this protocol. */
export const SESSION_MAX_FRAME_BYTES = 32 * 1024;

/**
 * Application names are tenant data, and they become a NATS subject token.
 *
 * Bounded and pattern-checked here rather than hashed-and-hoped: a name with a `>` in it would be
 * a wildcard subscription across a whole subject tree if anything downstream ever stopped hashing,
 * and the honest place to refuse that is at the edge, where the client can be told.
 */
const applicationName = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/u, "an application name may not contain wildcards");

export const sessionClaimFrameSchema = z.strictObject({
	op: z.literal("claim"),
	applications: z.array(applicationName).min(1).max(SESSION_MAX_APPLICATIONS),
	/** Echoed back on the reply, so a client can correlate. Opaque to the server. */
	id: z.string().max(64).optional(),
});

export const sessionReleaseFrameSchema = z.strictObject({
	op: z.literal("release"),
	applications: z.array(applicationName).min(1).max(SESSION_MAX_APPLICATIONS),
	id: z.string().max(64).optional(),
});

export const sessionVerbFrameSchema = z.strictObject({
	op: z.literal("verb"),
	sessionId: z.string().min(1).max(128),
	verb: z.enum(SESSION_VERBS),
	/**
	 * The SAME schema the engine validates against, imported rather than restated.
	 *
	 * Two copies of an argument list is how a field ends up accepted at the edge and ignored in the
	 * engine, which reads to an integrator as the platform silently dropping what they sent.
	 */
	arguments: sessionVerbArgumentsSchema.optional(),
	id: z.string().max(64).optional(),
});

export const sessionPingFrameSchema = z.strictObject({
	op: z.literal("ping"),
	id: z.string().max(64).optional(),
});

export const sessionClientFrameSchema = z.discriminatedUnion("op", [
	sessionClaimFrameSchema,
	sessionReleaseFrameSchema,
	sessionVerbFrameSchema,
	sessionPingFrameSchema,
]);

export type SessionClientFrame = z.infer<typeof sessionClientFrameSchema>;
export type SessionVerbFrame = z.infer<typeof sessionVerbFrameSchema>;

/** Why an application in a claim request was not granted. */
export interface SessionDeniedApplication {
	readonly application: string;
	readonly reason: "already-claimed" | "too-many-applications" | "upstream-unavailable";
}

/** Why a session ended, as the socket is told. */
export const SESSION_END_REASONS = [
	/** The call ended — the caller hung up, or a verb did. */
	"call-ended",
	/** This socket released the application, or closed. */
	"released",
	/** The control plane is shutting down. */
	"shutting-down",
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export type SessionServerFrame =
	| {
			readonly op: "welcome";
			readonly orgId: string;
			readonly heartbeatMs: number;
			readonly at: string;
	  }
	| {
			readonly op: "claimed";
			readonly applications: readonly string[];
			readonly denied: readonly SessionDeniedApplication[];
			readonly id?: string;
	  }
	| { readonly op: "released"; readonly applications: readonly string[]; readonly id?: string }
	| {
			readonly op: "session.started";
			readonly sessionId: string;
			readonly application: string;
			readonly callId: string;
			readonly legId: string;
			readonly direction: string;
			/** Whether the leg has already answered. An application must not assume it has. */
			readonly answered: boolean;
			readonly callerIdNumber?: string;
			readonly callerIdName?: string;
			readonly dialedNumber?: string;
			readonly arguments?: Readonly<Record<string, string>>;
			readonly at: string;
	  }
	| {
			readonly op: "session.ended";
			readonly sessionId: string;
			readonly callId: string;
			readonly reason: SessionEndReason;
			readonly at: string;
	  }
	| {
			readonly op: "result";
			readonly sessionId: string;
			readonly ok: boolean;
			readonly verb: string;
			/** Everything the engine's flat result carried. See `sessionVerbResponseSchema`. */
			readonly data: Readonly<Record<string, unknown>>;
			readonly id?: string;
	  }
	| {
			readonly op: "event";
			readonly sessionId: string;
			readonly callId: string;
			/** The `calls.evt.v1` event type, e.g. `channel.answered`. */
			readonly type: string;
			readonly at: string;
			readonly data: unknown;
	  }
	| { readonly op: "pong"; readonly at: string; readonly id?: string }
	| {
			readonly op: "error";
			readonly code: SessionErrorCode;
			readonly message: string;
			readonly id?: string;
	  };

export const SESSION_ERROR_CODES = [
	"BAD_FRAME",
	"FRAME_TOO_LARGE",
	"UNKNOWN_SESSION",
	"UPSTREAM_UNAVAILABLE",
] as const;
export type SessionErrorCode = (typeof SESSION_ERROR_CODES)[number];

/**
 * WebSocket close codes this gateway uses. The same numbering, and the same reasoning, as
 * `live-protocol.ts`: 1008 rather than 1011 for the authorization cases, because 1011 means the
 * server broke and a client that logged out would retry forever against a socket it can never open.
 */
export const SESSION_CLOSE_POLICY = 1008;
export const SESSION_CLOSE_ORGANIZATION_CHANGED = 4002;
export const SESSION_CLOSE_SERVER_SHUTDOWN = 1001;

/** The outcome of parsing one frame. A pair rather than a union, for `live-protocol.ts`'s reason. */
export interface SessionFrameResult {
	readonly frame: SessionClientFrame | undefined;
	/** Empty when {@link frame} is present. Never a partial explanation of a successful parse. */
	readonly reason: string;
}

/** Parses one client frame. Returns the reason rather than throwing, so the socket survives. */
export function parseSessionFrame(raw: string): SessionFrameResult {
	if (raw.length > SESSION_MAX_FRAME_BYTES) {
		return {
			frame: undefined,
			reason: `A frame may not exceed ${SESSION_MAX_FRAME_BYTES} bytes.`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { frame: undefined, reason: "Frames must be JSON objects." };
	}
	const result = sessionClientFrameSchema.safeParse(parsed);
	if (!result.success) {
		return {
			frame: undefined,
			reason: result.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; "),
		};
	}
	return { frame: result.data, reason: "" };
}
