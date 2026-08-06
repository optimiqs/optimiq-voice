/**
 * The serializer that puts an EVENT on the wire as the contract describes it.
 *
 * ## The defect this exists to fix
 *
 * NestJS's NATS transport serializes an emitted event as `{ ...packet, data }` — so a
 * `channel.created` published with `ClientProxy.emit` arrives on `calls.evt.v1.<org>.<call>.…` as
 * `{"pattern":"calls.evt…","data":{…the envelope…}}`, one level down from where every consumer
 * looks for it.
 *
 * That is not a cosmetic difference:
 *
 * - `@optimiq-voice/events` states that a message on an event subject IS the envelope, and
 *   `validateEvent` checks the envelope against the schema its subject selects. A wrapped message
 *   fails that check, which is exactly how this was found — the first test that ever read the bytes
 *   off the broker rather than the publisher's intent.
 * - The `CALLS` JetStream stream stores whatever is published on its subjects, so every replayed
 *   event would carry the wrapper too.
 * - `packages/events-go` generates Go structs from the same schemas. A Go consumer would not
 *   unmarshal these at all.
 *
 * ## Why not drop the Nest transport instead
 *
 * Plan §3.5 is explicit: no custom NATS framework — the Nest transport for core pub/sub, the raw
 * `nats` API only where JetStream durability or KV is genuinely needed. This keeps that decision.
 * It is a serializer, which is the extension point Nest provides for precisely this, not a
 * replacement for the transport.
 *
 * ## Events only
 *
 * REQUEST-REPLY must keep Nest's default. The responder on the other end of `rpc.routing.v1.resolve`
 * is a NestJS microservice: its server matches an inbound message by the `pattern` field and
 * correlates the reply by `id`, so a bare request on that subject is never answered and the caller
 * waits out its deadline while somebody listens to silence. That is why `NatsModule` registers two
 * clients and gives this serializer to one of them.
 */

const encoder = new TextEncoder();

/** The shape Nest's NATS client expects back from a serializer. */
interface NatsSerializedPacket {
	readonly data: Uint8Array;
	readonly headers?: unknown;
}

/**
 * Serializes an emitted packet's PAYLOAD, discarding Nest's envelope.
 *
 * Exported as a plain function so it can be unit-tested without a broker, and used as the
 * `serializer` option's `serialize` in `nats.module.ts`.
 */
export function serializeEnvelopeOnly(packet: {
	readonly pattern?: unknown;
	readonly data?: unknown;
}): NatsSerializedPacket {
	return { data: encoder.encode(JSON.stringify(packet.data)) };
}

/** The `serializer` option object Nest's `ClientsModule` takes. */
export const ENVELOPE_ONLY_SERIALIZER = { serialize: serializeEnvelopeOnly };
