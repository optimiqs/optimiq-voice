/**
 * The client half of the `/api/v1/live` protocol.
 *
 * Mirrors `apps/api/src/live/live-protocol.ts` and `live-topics.ts`. It is a hand-written mirror
 * for the same reason `lib/pbx/contracts.ts` is: there is no OpenAPI generator yet, and a mirror
 * that a spec compares against the server's own constants is a contract, whereas a mirror nobody
 * checks is a copy. `lib/live/protocol.spec.ts` does that comparison.
 *
 * Nothing here touches the DOM or a socket — it is the pure part, so the interesting logic (topic
 * naming, backoff, frame narrowing) is testable in `bun test`, which has no browser.
 */

/** Where the socket connects. Same-origin, so the Next `/api/:path*` rewrite forwards it. */
export const LIVE_PATH = "/api/v1/live";

/** Server → client ping interval it advertises. Used as the client's own liveness expectation. */
export const LIVE_DEFAULT_HEARTBEAT_MS = 25_000;

export type LiveTopic =
	| "registrations"
	| "active-calls"
	| "agent-state"
	| "voicemail"
	| "trunks"
	| "conferences"
	| `queue:${string}`;

/** The topic KINDS a `welcome` frame lists. `queue` needs an id appended to become a topic. */
export const LIVE_TOPIC_KINDS = [
	"registrations",
	"active-calls",
	"queue",
	"agent-state",
	"voicemail",
	"trunks",
	"conferences",
] as const;
export type LiveTopicKind = (typeof LIVE_TOPIC_KINDS)[number];

/** Builds the per-queue topic. Never concatenate one at a call site. */
export function queueTopic(queueId: string): LiveTopic {
	return `queue:${queueId}`;
}

/** The kind a topic belongs to, so a component can check it against the welcome frame. */
export function topicKind(topic: LiveTopic): LiveTopicKind {
	return topic.startsWith("queue:") ? "queue" : (topic as LiveTopicKind);
}

export interface LiveDeniedTopic {
	readonly topic: string;
	readonly reason: "unknown-topic" | "forbidden" | "too-many-topics";
	readonly permission?: string;
}

export type LiveServerFrame =
	| {
			readonly op: "welcome";
			readonly orgId: string;
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
			 * snapshot that threw the keys away would leave this client unable to remove the rows it
			 * had just been told to draw.
			 */
			readonly data: readonly { readonly key: string; readonly value: unknown }[];
	  }
	| {
			readonly op: "event";
			readonly topic: string;
			readonly kind: string;
			readonly at: string;
			/** `null` on a KV `delete`. */
			readonly data: unknown;
			/** The KV key. Absent for stream events, which have no key. */
			readonly key?: string;
	  }
	| { readonly op: "pong"; readonly at: string; readonly id?: string }
	| { readonly op: "error"; readonly code: string; readonly message: string; readonly id?: string };

/**
 * Narrows an incoming message.
 *
 * Returns `undefined` rather than throwing on anything unrecognised, including an `op` this build
 * has never heard of. That is the forward-compatibility half of the contract: the server ships
 * independently of the browser tab that is currently open, and a client that threw on a new frame
 * type would turn every additive server release into a broken dashboard for everyone who had not
 * reloaded.
 */
export function parseServerFrame(raw: string): LiveServerFrame | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const op = (parsed as { op?: unknown }).op;
	if (typeof op !== "string") {
		return undefined;
	}
	if (!KNOWN_OPS.has(op)) {
		return undefined;
	}
	return parsed as LiveServerFrame;
}

const KNOWN_OPS: ReadonlySet<string> = new Set([
	"welcome",
	"subscribed",
	"unsubscribed",
	"snapshot",
	"event",
	"pong",
	"error",
]);

/**
 * Reconnect backoff: 500 ms doubling to 15 s, with jitter.
 *
 * Jitter is not decoration. Every tab in an organization loses its socket at the same instant when
 * the API restarts, and a deterministic backoff reconnects all of them in the same millisecond —
 * which is a thundering herd against a process that has just started. The ±25 % spread costs
 * nothing and turns a spike into a ramp.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
	const base = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
	const jitter = base * 0.25 * (random() * 2 - 1);
	return Math.max(250, Math.round(base + jitter));
}

/**
 * The socket URL for the current page origin.
 *
 * Built from the page's own origin rather than from a configured API host, exactly as `apiFetch`
 * builds its relative paths: the browser talks only to the Next origin, and `next.config.mjs`'s
 * `/api/:path*` rewrite forwards to the API. A WebSocket upgrade goes through that rewrite —
 * Next's proxy handles the upgrade — and keeping the origin identical is also what keeps the
 * session cookie first-party, which a socket to another origin would not be.
 *
 * `https:` becomes `wss:`, which is not optional: a `ws://` socket opened from an `https://` page
 * is blocked as mixed content by every browser.
 */
export function liveSocketUrl(origin: string): string {
	const url = new URL(LIVE_PATH, origin);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

/** Close codes the client branches on. Mirrors the server's. */
export const LIVE_CLOSE_POLICY = 1008;
export const LIVE_CLOSE_SERVER_SHUTDOWN = 1001;

/**
 * Whether a close is worth reconnecting after.
 *
 * A policy close means the session ended or the organization changed, and reconnecting would open
 * a socket that is refused for the same reason — forever, at increasing volume. The page has to
 * re-authenticate or re-render instead, so the client stops and says so.
 */
export function shouldReconnect(code: number): boolean {
	return code !== LIVE_CLOSE_POLICY;
}
