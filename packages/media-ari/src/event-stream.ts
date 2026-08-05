import { computeBackoffDelayMs, DEFAULT_BACKOFF } from "./backoff";
import { AriEventParseError, AriSocketError } from "./errors";
import { parseAriEventFrame } from "./events";
import { redactAriUrl } from "./url";
import type { BackoffOptions } from "./backoff";
import type { AriEvent } from "./events";

/**
 * The ARI event WebSocket, with reconnection.
 *
 * ## Why a hand-rolled socket and not the `ws` package
 *
 * Node ≥22 ships a global `WebSocket`, and this adapter needs exactly one client socket with no
 * server, no extensions and no per-message compression. Adding `ws` would buy nothing except a
 * dependency that has to be kept in step with Node's own implementation. The one thing the WHATWG
 * constructor cannot do is set request headers, which is why authentication goes through ARI's
 * `api_key` query parameter — see `buildEventsUrl` for that trade-off.
 *
 * ## About "missed events"
 *
 * ARI has no sequence number and no replay: an event that happened while the socket was down is
 * gone, and no amount of reconnection logic gets it back. What this class can do — and does — is
 * make the loss VISIBLE: every reconnect reports a {@link AriEventGap} with how long the socket
 * was down and how many events the previous session had delivered. That is the signal the engine
 * uses to re-read channel state from REST instead of trusting its in-memory view, and it is why
 * the gap is a first-class callback rather than a log line.
 */

/** The lifecycle of the socket, as a health probe sees it. */
export const ARI_STREAM_STATUSES = [
	"idle",
	"connecting",
	"open",
	"reconnecting",
	"closed",
] as const;

export type AriStreamStatus = (typeof ARI_STREAM_STATUSES)[number];

/** Reported on every successful reconnect: the window during which events were lost. */
export interface AriEventGap {
	/** Epoch millis when the previous socket closed. */
	readonly disconnectedAt: number;
	/** Epoch millis when the new socket opened. */
	readonly reconnectedAt: number;
	readonly downtimeMs: number;
	/** How many events the previous session delivered before it died. */
	readonly eventsBeforeGap: number;
	/** How many connection attempts it took. */
	readonly attempts: number;
}

export interface AriEventStreamHandlers {
	/** One typed event. Throwing here is caught and routed to `onError`, never left unhandled. */
	readonly onEvent: (event: AriEvent) => void;
	readonly onStatusChange?: (status: AriStreamStatus) => void;
	/** Parse failures, socket failures and handler failures all arrive here. */
	readonly onError?: (error: unknown) => void;
	/** A reconnect completed and events were lost in between. */
	readonly onGap?: (gap: AriEventGap) => void;
}

export interface AriEventStreamOptions {
	/** Already built by `buildEventsUrl` — it carries the credentials. */
	readonly url: string;
	readonly handlers: AriEventStreamHandlers;
	readonly backoff?: BackoffOptions;
	/** How long to wait for the socket to open before treating the attempt as failed. */
	readonly openTimeoutMs?: number;
	/** Injection seams for tests. */
	readonly webSocketFactory?: (url: string) => WebSocket;
	readonly random?: () => number;
	readonly now?: () => number;
}

const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
/** WebSocket close code for a deliberate, normal shutdown. */
const NORMAL_CLOSURE = 1000;

export class AriEventStream {
	private readonly options: AriEventStreamOptions;
	private readonly backoff: BackoffOptions;
	private readonly random: () => number;
	private readonly now: () => number;

	private socket: WebSocket | undefined;
	private currentStatus: AriStreamStatus = "idle";
	private stopped = true;
	private attempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private openTimer: ReturnType<typeof setTimeout> | undefined;
	private eventsThisSession = 0;
	private disconnectedAt: number | undefined;
	private totalEvents = 0;

	constructor(options: AriEventStreamOptions) {
		this.options = options;
		this.backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.random = options.random ?? Math.random;
		this.now = options.now ?? Date.now;
	}

	get status(): AriStreamStatus {
		return this.currentStatus;
	}

	/** Whether the socket is currently usable. What `/healthz` reports. */
	get isOpen(): boolean {
		return this.currentStatus === "open";
	}

	/** Total events delivered since `start()`, across reconnects. */
	get eventCount(): number {
		return this.totalEvents;
	}

	/** Log-safe URL — credentials replaced. */
	get redactedUrl(): string {
		return redactAriUrl(this.options.url);
	}

	/**
	 * Opens the socket and keeps it open until {@link close}.
	 *
	 * Resolves as soon as the FIRST connection is established, so a bootstrap can fail fast on a
	 * misconfigured URL or bad credentials rather than silently entering a retry loop. Every
	 * subsequent drop is handled in the background.
	 */
	async start(): Promise<void> {
		if (!this.stopped) {
			return;
		}
		this.stopped = false;
		this.attempts = 0;
		await this.connect();
	}

	/** Closes the socket and cancels any pending reconnect. Idempotent. */
	close(): void {
		this.stopped = true;
		this.clearTimers();
		const socket = this.socket;
		this.socket = undefined;
		if (socket !== undefined) {
			this.detach(socket);
			try {
				socket.close(NORMAL_CLOSURE, "engine shutdown");
			} catch (error) {
				this.reportError(error);
			}
		}
		this.setStatus("closed");
	}

	private connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");

			let socket: WebSocket;
			try {
				socket = this.createSocket();
			} catch (error) {
				reject(new AriSocketError(`ARI event socket could not be created: ${String(error)}`));
				return;
			}
			this.socket = socket;

			let settled = false;
			const settleOk = () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};
			const settleErr = (error: unknown) => {
				if (!settled) {
					settled = true;
					reject(error);
				}
			};

			this.openTimer = setTimeout(() => {
				settleErr(new AriSocketError("ARI event socket did not open before the timeout"));
				this.teardownAndScheduleReconnect(socket);
			}, this.options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);

			socket.onopen = () => {
				this.clearOpenTimer();
				this.reportGapIfAny();
				this.attempts = 0;
				this.eventsThisSession = 0;
				this.setStatus("open");
				settleOk();
			};

			socket.onmessage = (message: MessageEvent) => {
				this.handleMessage(message.data);
			};

			socket.onerror = () => {
				// The WHATWG `error` event carries no diagnostic payload by design; `close` always
				// follows it, and that is where the code and reason live. Recording it here would
				// double-report the same failure.
			};

			socket.onclose = (event: CloseEvent) => {
				this.clearOpenTimer();
				if (!settled) {
					settleErr(
						new AriSocketError("ARI event socket closed before it opened", {
							code: event.code,
							reason: event.reason,
						}),
					);
				}
				this.teardownAndScheduleReconnect(socket);
			};
		});
	}

	private createSocket(): WebSocket {
		const factory = this.options.webSocketFactory;
		if (factory !== undefined) {
			return factory(this.options.url);
		}
		if (typeof globalThis.WebSocket !== "function") {
			throw new AriSocketError(
				"No global WebSocket. Node 22.4+ or Bun is required, or pass webSocketFactory.",
			);
		}
		return new globalThis.WebSocket(this.options.url);
	}

	private handleMessage(data: unknown): void {
		this.eventsThisSession += 1;
		this.totalEvents += 1;

		let frame: string;
		if (typeof data === "string") {
			frame = data;
		} else if (data instanceof ArrayBuffer) {
			frame = new TextDecoder().decode(data);
		} else {
			this.reportError(new AriEventParseError("frame is neither text nor binary", String(data)));
			return;
		}

		let event: AriEvent;
		try {
			event = parseAriEventFrame(frame);
		} catch (error) {
			// A poison frame is dropped and reported, never rethrown: an exception inside a socket
			// callback is an unhandled rejection that takes the process down, and one malformed
			// event must not end every call on the box.
			this.reportError(error);
			return;
		}

		try {
			this.options.handlers.onEvent(event);
		} catch (error) {
			this.reportError(error);
		}
	}

	private teardownAndScheduleReconnect(socket: WebSocket): void {
		this.detach(socket);
		if (this.socket === socket) {
			this.socket = undefined;
		}
		if (this.stopped) {
			this.setStatus("closed");
			return;
		}
		this.disconnectedAt ??= this.now();
		this.setStatus("reconnecting");
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer !== undefined) {
			return;
		}
		this.attempts += 1;
		const delay = computeBackoffDelayMs(this.attempts, this.backoff, this.random);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			if (this.stopped) {
				return;
			}
			// Failures of a background reconnect are reported, not thrown: `connect` rejects, and
			// `onclose` has already scheduled the next attempt.
			this.connect().catch((error: unknown) => {
				this.reportError(error);
			});
		}, delay);
		// A pending reconnect must not hold the process open during a drain.
		this.reconnectTimer.unref?.();
	}

	private reportGapIfAny(): void {
		const disconnectedAt = this.disconnectedAt;
		if (disconnectedAt === undefined) {
			return;
		}
		this.disconnectedAt = undefined;
		const reconnectedAt = this.now();
		this.options.handlers.onGap?.({
			disconnectedAt,
			reconnectedAt,
			downtimeMs: reconnectedAt - disconnectedAt,
			eventsBeforeGap: this.eventsThisSession,
			attempts: this.attempts,
		});
	}

	private detach(socket: WebSocket): void {
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
	}

	private setStatus(status: AriStreamStatus): void {
		if (this.currentStatus === status) {
			return;
		}
		this.currentStatus = status;
		try {
			this.options.handlers.onStatusChange?.(status);
		} catch (error) {
			this.reportError(error);
		}
	}

	private reportError(error: unknown): void {
		const onError = this.options.handlers.onError;
		if (onError === undefined) {
			return;
		}
		try {
			onError(error);
		} catch {
			// An error handler that throws is the end of the line; there is nowhere left to report.
		}
	}

	private clearOpenTimer(): void {
		if (this.openTimer !== undefined) {
			clearTimeout(this.openTimer);
			this.openTimer = undefined;
		}
	}

	private clearTimers(): void {
		this.clearOpenTimer();
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}
}
