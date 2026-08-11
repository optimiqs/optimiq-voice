import { headers, type NatsConnection } from "nats";

/**
 * The raw NATS request seam for `rpc.media.v1.*`.
 *
 * ## Why this is not a NestJS `ClientProxy`
 *
 * It is the single most important line in this directory, so it is stated here as well as in the
 * contract: **`mediad` is a Go responder and the engine's client MUST issue a raw request.**
 *
 * NestJS's NATS transport does not put a payload on the wire; it wraps it:
 *
 * ```text
 * request   {"pattern":"rpc.media.v1.allocate-session","data":{…the schema…},"id":"…"}
 * reply     {"response":{…the schema…},"isDisposed":true,"id":"…"}
 * ```
 *
 * `apps/mediad` unmarshals the bare contract struct. Handed a `ClientProxy` frame it would see a
 * request with no `sessionId`, refuse it as `bad_request`, and answer in a shape the `ClientProxy`
 * would not recognise either — so the visible symptom is "every call times out at the media plane",
 * three layers away from the serializer that caused it. Every prior `rpc.*` subject on this backbone
 * had a TypeScript responder, so this failure has never been reachable before.
 *
 * The engine already holds a raw connection for JetStream and KV
 * (`src/nats/jetstream.service.ts`), so speaking raw here costs nothing.
 *
 * ## Why it is an interface
 *
 * So a spec can drive the whole adapter with no broker, exactly as `claim-store.fake.ts` does for
 * KV. The transport is the only part of `MediadMediaPort` that touches the network; making it the
 * seam means every refusal path, every framing decision and every event mapping is covered by a
 * fast unit spec, and the gated integration suite is left to prove the wire.
 */
export interface MediadTransport {
	/**
	 * Issues one request and resolves the decoded JSON reply.
	 *
	 * @throws when the request times out or the reply is not JSON. A REFUSAL is not a throw — it
	 * arrives as `{ok: false, reason}` and the caller branches on it, because `mediad` answers every
	 * request it dislikes rather than staying silent.
	 */
	request(subject: string, payload: unknown, timeoutMs: number): Promise<unknown>;

	/** Whether the transport can reach a broker at all. Read by the health endpoint. */
	readonly isConnected: boolean;
}

/** Thrown when a `mediad` reply cannot be read at all — a timeout, or bytes that are not JSON. */
export class MediadTransportError extends Error {
	readonly subject: string;

	constructor(subject: string, message: string, options?: { cause?: unknown }) {
		super(`mediad ${subject}: ${message}`, options);
		this.name = "MediadTransportError";
		this.subject = subject;
	}
}

/**
 * {@link MediadTransport} over a live NATS connection.
 *
 * The connection is INJECTED rather than opened here: the engine already owns exactly one raw
 * connection, and a second one would be a second thing to authenticate, drain and reconnect for no
 * benefit. See `JetStreamService`, which owns it.
 */
export class NatsMediadTransport implements MediadTransport {
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	/**
	 * @param connectionOf reads the live connection each time rather than capturing it.
	 *
	 * An accessor and not a value because Nest builds every provider BEFORE it initialises any of
	 * them, and the connection is opened in `JetStreamService.onModuleInit`. Capturing at
	 * construction would capture `undefined` on every boot.
	 */
	constructor(private readonly connectionOf: () => NatsConnection | undefined) {}

	get isConnected(): boolean {
		const connection = this.connectionOf();
		return connection !== undefined && !connection.isClosed();
	}

	async request(subject: string, payload: unknown, timeoutMs: number): Promise<unknown> {
		const connection = this.connectionOf();
		if (connection === undefined) {
			throw new MediadTransportError(subject, "the engine has no NATS connection yet");
		}
		let reply: { data: Uint8Array };
		try {
			reply = await connection.request(subject, this.encoder.encode(JSON.stringify(payload)), {
				timeout: timeoutMs,
				// An empty header set, so the request carries the same shape as `apps/sipd`'s. NATS
				// puts nothing of its own in a core request, which is the property that makes the
				// bytes on the wire exactly the contract.
				headers: headers(),
			});
		} catch (error) {
			// A timeout here means one of: no `mediad` is subscribed, every `mediad` is too busy to
			// answer, or the broker dropped the request. The caller cannot tell them apart and does
			// not need to — all three mean this leg cannot get media from this plane right now.
			throw new MediadTransportError(subject, `no reply within ${timeoutMs}ms`, { cause: error });
		}

		try {
			return JSON.parse(this.decoder.decode(reply.data)) as unknown;
		} catch (error) {
			throw new MediadTransportError(subject, "the reply was not JSON", { cause: error });
		}
	}
}
