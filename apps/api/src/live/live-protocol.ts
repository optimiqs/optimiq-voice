import { z } from "zod/v4";

/**
 * The `/api/v1/live` wire protocol.
 *
 * ## Shape
 *
 * Every frame is one JSON object with an `op`. Client frames are validated against the schemas
 * below before anything acts on them — a WebSocket is an authenticated caller sending arbitrary
 * bytes for as long as the connection lives, which is a longer window than any HTTP request, and
 * "the body was parsed once at the edge" is exactly the property a socket does not have for free.
 *
 * ```
 * client -> server                       server -> client
 * ----------------------------------     -------------------------------------------------------
 * {op:"subscribe", topics:[…], id?}      {op:"welcome", orgId, topics:[…], heartbeatMs, at}
 * {op:"unsubscribe", topics:[…], id?}    {op:"subscribed", topics:[…], denied:[…], id?}
 * {op:"ping", id?}                       {op:"unsubscribed", topics:[…], id?}
 *                                        {op:"snapshot", topic, at, data:[…]}
 *                                        {op:"event", topic, kind, at, data}
 *                                        {op:"pong", at, id?}
 *                                        {op:"error", code, message, id?}
 * ```
 *
 * ## Snapshot-then-stream, and why there is no cursor
 *
 * A subscribe is answered with a `snapshot` — the CURRENT contents of the relevant KV bucket for
 * this organization — and then with `event` frames as things change. There is deliberately no
 * replay, no sequence number and no "give me everything since X":
 *
 * - The buckets are the authority for live state. Anything a client missed while disconnected is,
 *   by definition, either still in the bucket (so the snapshot has it) or no longer true (so
 *   replaying it would draw a call that has ended).
 * - A cursor would make this a durable consumer per browser tab, which is a JetStream resource with
 *   a lifetime nobody deletes when a laptop lid closes.
 *
 * So the RESUBSCRIBE PROTOCOL is: reconnect, send `subscribe` with the same topics, and take the
 * snapshot as truth. A client that patched its cache from `event` frames must reset it from the
 * snapshot rather than merging, because the gap is unbounded.
 *
 * ## Heartbeat
 *
 * The server sends a WebSocket-level `ping` every {@link LIVE_HEARTBEAT_MS} and terminates a
 * connection that has not ponged within {@link LIVE_HEARTBEAT_TIMEOUT_MS}. Browsers answer
 * protocol pings automatically and cannot send them, so the `ping`/`pong` OPS exist as well — a
 * client that wants to prove the connection is alive from its own side sends `{op:"ping"}`. Both
 * exist because they answer different questions: the protocol ping tells the SERVER a dead socket
 * can be reaped, and the app-level one tells the CLIENT its socket is not a black hole (a TCP
 * connection through a dead NAT stays writable for minutes).
 */

/** Server → client ping interval. Comfortably inside the 60 s idle timeout of most proxies. */
export const LIVE_HEARTBEAT_MS = 25_000;

/** A socket that has not answered two heartbeats is gone, whatever TCP believes. */
export const LIVE_HEARTBEAT_TIMEOUT_MS = LIVE_HEARTBEAT_MS * 2 + 5_000;

/** The path the gateway is mounted on. */
export const LIVE_PATH = "/api/v1/live";

/**
 * Per-connection topic ceiling.
 *
 * Each topic can open upstream watches, so an unbounded subscribe list is a way for one
 * authenticated tab to make the server hold N NATS subscriptions. Twenty is more queues than any
 * wallboard renders at once and is the point at which the answer is a different screen.
 */
export const LIVE_MAX_TOPICS_PER_CONNECTION = 20;

/** Frames larger than this are a client that is not speaking this protocol. */
export const LIVE_MAX_FRAME_BYTES = 16 * 1024;

const topicName = z.string().min(1).max(64);

export const liveSubscribeFrameSchema = z.strictObject({
	op: z.literal("subscribe"),
	topics: z.array(topicName).min(1).max(LIVE_MAX_TOPICS_PER_CONNECTION),
	/** Echoed back on the reply, so a client can correlate. Opaque to the server. */
	id: z.string().max(64).optional(),
});

export const liveUnsubscribeFrameSchema = z.strictObject({
	op: z.literal("unsubscribe"),
	topics: z.array(topicName).min(1).max(LIVE_MAX_TOPICS_PER_CONNECTION),
	id: z.string().max(64).optional(),
});

export const livePingFrameSchema = z.strictObject({
	op: z.literal("ping"),
	id: z.string().max(64).optional(),
});

export const liveClientFrameSchema = z.discriminatedUnion("op", [
	liveSubscribeFrameSchema,
	liveUnsubscribeFrameSchema,
	livePingFrameSchema,
]);

export type LiveClientFrame = z.infer<typeof liveClientFrameSchema>;

/** Why a topic in a subscribe request was not granted. */
export interface LiveDeniedTopic {
	readonly topic: string;
	readonly reason: "unknown-topic" | "forbidden" | "too-many-topics";
	/** The permission that would have granted it, when there is one. */
	readonly permission?: string;
}

export type LiveServerFrame =
	| {
			readonly op: "welcome";
			readonly orgId: string;
			/** The topic KINDS this session could subscribe to. `queue` needs an id appended. */
			readonly topics: readonly string[];
			readonly heartbeatMs: number;
			readonly at: string;
	  }
	| {
			readonly op: "subscribed";
			readonly topics: readonly string[];
			readonly denied: readonly LiveDeniedTopic[];
			readonly id?: string;
	  }
	| { readonly op: "unsubscribed"; readonly topics: readonly string[]; readonly id?: string }
	| {
			readonly op: "snapshot";
			readonly topic: string;
			readonly at: string;
			/**
			 * `{ key, value }` pairs, not bare values.
			 *
			 * A KV projection IS a key→value map, and a later `delete` names only the key — so a
			 * snapshot that threw the keys away would leave a client unable to remove the rows it had
			 * been told to draw. The pair is what makes the two halves of the protocol composable.
			 */
			readonly data: readonly { readonly key: string; readonly value: unknown }[];
	  }
	| {
			readonly op: "event";
			readonly topic: string;
			/** What changed: `put`/`delete` for a KV projection, the event `type` for a stream. */
			readonly kind: string;
			readonly at: string;
			/** `null` on a KV `delete`. */
			readonly data: unknown;
			/** The KV key this concerns. Absent for stream events, which have no key. */
			readonly key?: string;
	  }
	| { readonly op: "pong"; readonly at: string; readonly id?: string }
	| {
			readonly op: "error";
			readonly code: LiveErrorCode;
			readonly message: string;
			readonly id?: string;
	  };

export const LIVE_ERROR_CODES = [
	"BAD_FRAME",
	"FRAME_TOO_LARGE",
	"TOPIC_LIMIT",
	"UPSTREAM_UNAVAILABLE",
] as const;
export type LiveErrorCode = (typeof LIVE_ERROR_CODES)[number];

/**
 * WebSocket close codes this gateway uses.
 *
 * 1008 (policy violation) rather than 1011 for the authorization cases: 1011 means the server broke,
 * and a client that logged out and got a 1011 would retry forever against a socket it can never
 * open. 4000+ is the application range; `LIVE_CLOSE_SESSION_EXPIRED` is distinct from a plain policy
 * close so a client can tell "re-authenticate" from "stop trying".
 */
export const LIVE_CLOSE_POLICY = 1008;
export const LIVE_CLOSE_SESSION_EXPIRED = 4001;
export const LIVE_CLOSE_ORGANIZATION_CHANGED = 4002;
export const LIVE_CLOSE_SERVER_SHUTDOWN = 1001;

/**
 * The outcome of parsing one frame.
 *
 * A pair rather than a `{ok:true}|{ok:false}` union on purpose: `apps/api`'s tooling tsconfig still
 * relaxes `strictNullChecks` for its legacy files, and without it a boolean-literal discriminant
 * does not narrow — so a union would compile in `tsconfig.strict.json` and fail in the project
 * `tsx` and `mocha` actually load. `frame === undefined` narrows in both.
 */
export interface LiveFrameResult {
	readonly frame: LiveClientFrame | undefined;
	/** Empty when {@link frame} is present. Never a partial explanation of a successful parse. */
	readonly reason: string;
}

/** Parses one client frame. Returns the reason rather than throwing, so the socket survives. */
export function parseClientFrame(raw: string): LiveFrameResult {
	if (raw.length > LIVE_MAX_FRAME_BYTES) {
		return {
			frame: undefined,
			reason: `A frame may not exceed ${LIVE_MAX_FRAME_BYTES} bytes.`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { frame: undefined, reason: "Frames must be JSON objects." };
	}
	const result = liveClientFrameSchema.safeParse(parsed);
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
