import {
	liveSocketUrl,
	LIVE_DEFAULT_HEARTBEAT_MS,
	parseServerFrame,
	reconnectDelayMs,
	shouldReconnect,
	type LiveDeniedTopic,
	type LiveServerFrame,
	type LiveTopic,
} from "./protocol";

/**
 * The browser's end of `/api/v1/live`: one socket per tab, shared by every component that wants
 * live state.
 *
 * ## One socket, ref-counted topics
 *
 * The server ref-counts its upstream watches per organization; this does the same one layer down,
 * per topic. A dashboard renders three tiles from `registrations`, `active-calls` and
 * `agent-state`, and a queue page adds `queue:<id>` — if each of those opened its own socket the
 * server would resolve four sessions, run four heartbeats and hold four sets of leases for one
 * user looking at one screen. So subscription is a LEASE: `subscribe` hands back a release
 * function, the topic is sent to the server on the first lease and dropped on the last.
 *
 * ## Reconnect resets, it does not resume
 *
 * On reconnect the client re-sends its whole topic set and treats the resulting `snapshot` as
 * truth, discarding whatever it had. That is the protocol's own contract (there is no cursor and
 * no replay — see `apps/api/src/live/live-protocol.ts`), and it is the honest behaviour: the gap is
 * unbounded, so a merge would silently keep a call that ended while the laptop lid was shut.
 * `onSnapshot` therefore means "replace", never "add".
 *
 * ## Why this is a class and not a hook
 *
 * A socket outlives any one component, has to survive a route change, and is torn down when the
 * authenticated shell unmounts — the same lifetime as the QueryClient, which is also a plain
 * object owned by the layout. Hooks subscribe to it; they do not own it.
 */

export type LiveStatus = "connecting" | "open" | "closed" | "refused";

export interface LiveSnapshotEvent {
	readonly topic: LiveTopic;
	readonly rows: readonly { readonly key: string; readonly value: unknown }[];
	readonly at: string;
}

export interface LiveUpdateEvent {
	readonly topic: LiveTopic;
	/** `put` / `delete` for a KV projection; the event `type` for a stream event. */
	readonly kind: string;
	readonly at: string;
	readonly data: unknown;
	/** Present for KV projections. On a `delete` it is the ONLY identity available. */
	readonly key?: string;
}

export interface LiveTopicHandlers {
	readonly onSnapshot?: (event: LiveSnapshotEvent) => void;
	readonly onUpdate?: (event: LiveUpdateEvent) => void;
	/** Called when the server refuses the topic — a missing permission, or an unknown name. */
	readonly onDenied?: (denied: LiveDeniedTopic) => void;
}

export interface LiveClientOptions {
	readonly origin: string;
	/** Injected so a spec can drive the client without a browser. */
	readonly createSocket?: (url: string) => LiveSocket;
	readonly setTimeoutFn?: (handler: () => void, ms: number) => number;
	readonly clearTimeoutFn?: (handle: number) => void;
	readonly random?: () => number;
}

/** The slice of `WebSocket` this client uses. Structural, so a spec can supply a fake. */
export interface LiveSocket {
	send(data: string): void;
	close(): void;
	onopen: ((this: unknown, event: unknown) => void) | null;
	onmessage: ((this: unknown, event: { data: unknown }) => void) | null;
	onclose: ((this: unknown, event: { code: number; reason?: string }) => void) | null;
	onerror: ((this: unknown, event: unknown) => void) | null;
}

interface Lease {
	readonly handlers: LiveTopicHandlers;
}

export class LiveClient {
	private socket: LiveSocket | undefined;
	private readonly leases = new Map<LiveTopic, Set<Lease>>();
	private readonly statusListeners = new Set<(status: LiveStatus) => void>();
	private readonly welcomeListeners = new Set<(topics: readonly string[]) => void>();
	private readonly options: LiveClientOptions;
	private attempt = 0;
	private retryHandle: number | undefined;
	private stopped = false;
	private statusValue: LiveStatus = "closed";
	private allowedKinds: readonly string[] = [];

	constructor(options: LiveClientOptions) {
		this.options = options;
	}

	get status(): LiveStatus {
		return this.statusValue;
	}

	/** The topic kinds the server said this session may watch, from the `welcome` frame. */
	get allowedTopicKinds(): readonly string[] {
		return this.allowedKinds;
	}

	onStatusChange(listener: (status: LiveStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	/**
	 * Notified when a `welcome` frame lands, with the topic kinds this session may watch.
	 *
	 * Separate from the status listener because the two happen at different moments: `open` fires on
	 * the handshake and `welcome` arrives a round trip later. A consumer that read
	 * {@link allowedTopicKinds} on the status change would read it before the server had said
	 * anything — and would then never be told, because there is no second status change to prompt it.
	 */
	onWelcome(listener: (topics: readonly string[]) => void): () => void {
		this.welcomeListeners.add(listener);
		return () => {
			this.welcomeListeners.delete(listener);
		};
	}

	/**
	 * Takes a lease on a topic. Returns the release.
	 *
	 * Connecting is lazy — the socket opens on the first lease — so a user who never visits a live
	 * screen never opens one. That matters because the server resolves a session and starts a
	 * heartbeat per connection, and most pages in this app are ordinary CRUD.
	 */
	subscribe(topic: LiveTopic, handlers: LiveTopicHandlers): () => void {
		const lease: Lease = { handlers };
		const existing = this.leases.get(topic);
		if (existing === undefined) {
			this.leases.set(topic, new Set([lease]));
			this.sendSubscribe([topic]);
		} else {
			existing.add(lease);
			// A late joiner has no snapshot of its own, so it is told to re-subscribe: the server
			// answers a repeated subscribe with a fresh snapshot rather than refusing it, precisely so
			// a second component mounting onto an open topic starts with state instead of waiting for
			// the next thing to change.
			this.sendSubscribe([topic]);
		}
		this.connect();

		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const holders = this.leases.get(topic);
			if (holders === undefined) {
				return;
			}
			holders.delete(lease);
			if (holders.size > 0) {
				return;
			}
			this.leases.delete(topic);
			this.send({ op: "unsubscribe", topics: [topic] });
			if (this.leases.size === 0) {
				// Nothing on screen wants live state any more. Holding the socket open would keep a
				// server-side session resolution and heartbeat alive for a page that is not watching.
				this.disconnect();
			}
		};
	}

	/** Opens the socket if it is not already open or opening. */
	connect(): void {
		if (this.socket !== undefined || this.stopped) {
			return;
		}
		this.setStatus("connecting");
		const socket = (this.options.createSocket ?? defaultCreateSocket)(
			liveSocketUrl(this.options.origin),
		);
		this.socket = socket;

		socket.onopen = () => {
			this.attempt = 0;
			this.setStatus("open");
			// The whole topic set, not the ones added since: a reconnect is a new server-side
			// connection that knows nothing about this client.
			const topics = [...this.leases.keys()];
			if (topics.length > 0) {
				this.send({ op: "subscribe", topics });
			}
		};

		socket.onmessage = (event) => {
			if (typeof event.data !== "string") {
				return;
			}
			const frame = parseServerFrame(event.data);
			if (frame !== undefined) {
				this.dispatch(frame);
			}
		};

		socket.onclose = (event) => {
			this.socket = undefined;
			if (this.stopped) {
				this.setStatus("closed");
				return;
			}
			if (!shouldReconnect(event.code)) {
				// The session ended or the organization changed. Retrying would open a socket refused
				// for the same reason, forever, at increasing volume.
				this.setStatus("refused");
				return;
			}
			this.setStatus("closed");
			this.scheduleReconnect();
		};

		socket.onerror = () => {
			// `onclose` always follows, and it carries the code. Handled only so an error on a
			// closing socket does not surface as an unhandled event.
		};
	}

	/** Closes the socket and stops reconnecting. Called when the authenticated shell unmounts. */
	destroy(): void {
		this.stopped = true;
		this.leases.clear();
		this.disconnect();
		this.statusListeners.clear();
		this.welcomeListeners.clear();
	}

	private disconnect(): void {
		if (this.retryHandle !== undefined) {
			(this.options.clearTimeoutFn ?? defaultClearTimeout)(this.retryHandle);
			this.retryHandle = undefined;
		}
		const socket = this.socket;
		this.socket = undefined;
		socket?.close();
		this.setStatus("closed");
	}

	private scheduleReconnect(): void {
		if (this.leases.size === 0 || this.retryHandle !== undefined) {
			return;
		}
		const delay = reconnectDelayMs(this.attempt, this.options.random);
		this.attempt += 1;
		this.retryHandle = (this.options.setTimeoutFn ?? defaultSetTimeout)(() => {
			this.retryHandle = undefined;
			this.connect();
		}, delay);
	}

	private sendSubscribe(topics: readonly LiveTopic[]): void {
		this.send({ op: "subscribe", topics });
	}

	private send(frame: Record<string, unknown>): void {
		try {
			this.socket?.send(JSON.stringify(frame));
		} catch {
			// A socket that is closing throws on send. `onclose` is already scheduled; there is
			// nothing useful to do here and throwing would take the caller's render down with it.
		}
	}

	private dispatch(frame: LiveServerFrame): void {
		switch (frame.op) {
			case "welcome":
				this.allowedKinds = frame.topics;
				for (const listener of this.welcomeListeners) {
					listener(frame.topics);
				}
				return;
			case "subscribed":
				for (const denied of frame.denied) {
					const holders = this.leases.get(denied.topic as LiveTopic);
					for (const lease of holders ?? []) {
						lease.handlers.onDenied?.(denied);
					}
				}
				return;
			case "snapshot": {
				const holders = this.leases.get(frame.topic as LiveTopic);
				for (const lease of holders ?? []) {
					lease.handlers.onSnapshot?.({
						topic: frame.topic as LiveTopic,
						rows: frame.data,
						at: frame.at,
					});
				}
				return;
			}
			case "event": {
				const holders = this.leases.get(frame.topic as LiveTopic);
				for (const lease of holders ?? []) {
					lease.handlers.onUpdate?.({
						topic: frame.topic as LiveTopic,
						kind: frame.kind,
						at: frame.at,
						data: frame.data,
						...(frame.key === undefined ? {} : { key: frame.key }),
					});
				}
				return;
			}
			default:
				// `pong`, `unsubscribed` and `error` need no per-topic dispatch. `error` is
				// deliberately not surfaced as a thrown value: the socket is still usable, and the
				// codes it carries (a bad frame, a missing broker) are diagnostics rather than
				// something a tile can render.
				return;
		}
	}

	private setStatus(status: LiveStatus): void {
		if (this.statusValue === status) {
			return;
		}
		this.statusValue = status;
		for (const listener of this.statusListeners) {
			listener(status);
		}
	}
}

function defaultCreateSocket(url: string): LiveSocket {
	return new WebSocket(url) as unknown as LiveSocket;
}

function defaultSetTimeout(handler: () => void, ms: number): number {
	return globalThis.setTimeout(handler, ms) as unknown as number;
}

function defaultClearTimeout(handle: number): void {
	globalThis.clearTimeout(handle);
}

export { LIVE_DEFAULT_HEARTBEAT_MS };
