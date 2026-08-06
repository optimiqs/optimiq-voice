import { z } from "zod";
import { eventInstantSchema } from "./envelope";
import { sipTransportSchema } from "./telephony";

/**
 * The two live-state KV VALUE contracts a READER outside the writing process has to parse:
 * `registrations` and `channels`.
 *
 * ## Why these are here, next to `queue-state.ts`
 *
 * Same argument, one step further. `queue-state.ts` covers the two ACD buckets because they are
 * written by one process and read by another; these two are written by processes in a DIFFERENT
 * LANGUAGE from at least one of their readers. `registrations` is written by `apps/sipd` in Go
 * (`internal/kv/kv.go`'s `Binding`) and is about to be read by `apps/api` in TypeScript to drive a
 * wallboard; `channels` is written by `apps/engine` and read by the same wallboard. A shape agreed
 * across a language border by nothing but two struct definitions is a shape that drifts, and the
 * failure mode here is the one that looks most like "the feature is broken": a registrations panel
 * that renders nothing because a field was renamed, on a system where "nobody is registered" is
 * also a completely plausible answer.
 *
 * ## These are TOLERANT schemas, and that is the point
 *
 * Every object here is `.loose()`. A KV value is written by a process on its own release cadence,
 * and a reader that rejected an entry for carrying a field it had not heard of would turn every
 * forward-compatible write on the other side of the border into an outage on this one. What the
 * schemas pin is the set of fields a reader ACTS on — the ones whose absence or wrong type would
 * make the reader render a lie — and nothing else.
 *
 * The asymmetry with the event envelopes is deliberate: an event is validated at the edge because
 * an unparseable one must not be filed, and events carry a `v` the envelope negotiates. A KV value
 * is a snapshot with no version negotiation and no consumer to ack it, so strictness there buys
 * nothing and costs availability.
 *
 * ## Not in the Go codegen registry
 *
 * `registrations` is the one bucket whose Go side is the AUTHORITY rather than a consumer: `sipd`
 * declares `Binding` and this mirrors it. Registering it would generate a second Go struct for a
 * shape Go already owns, and the parity golden would then pin the copy rather than the original.
 * The mirror is asserted the way the rest of the border is — by a spec that reads the Go source's
 * JSON tags — and that check is recorded as a follow-up alongside the `events-go` work.
 */

// ---------------------------------------------------------------------------------------------
// registrations
// ---------------------------------------------------------------------------------------------

/**
 * One AOR → contact binding, as the `registrations` bucket holds it.
 *
 * Mirrors `apps/sipd/internal/kv/kv.go`'s `Binding`, field for field, by its JSON tags. The
 * comments below say what a READER may conclude from each field, which is not always what the
 * writer meant by it.
 */
export const registrationBindingSchema = z
	.object({
		orgId: z.string().min(1),
		/** The full Address of Record, e.g. `sip:1001@acme.example.com`. PII-adjacent. */
		aor: z.string().min(1).max(512),
		/** The subject/key token for the AOR — see `aorSubjectToken`. */
		aorHash: z.string().min(1).max(64),
		/**
		 * The contact URI exactly as the device offered it, parameters included.
		 *
		 * Never routable on its own from outside the SIP edge: a device behind NAT advertises a
		 * private address here, which is why `sourceAddress` exists. A UI must show this as
		 * information, never as somewhere to send anything.
		 */
		contact: z.string().min(1).max(1024),
		transport: sipTransportSchema,
		userAgent: z.string().max(256).optional(),
		/** The signalling peer, `host:port`, as observed. The address that actually works. */
		sourceAddress: z.string().max(128).optional(),
		deviceId: z.string().max(64).optional(),
		extensionId: z.string().max(64).optional(),
		callId: z.string().max(256).optional(),
		cseq: z.int().min(0).optional(),
		/** The device's `+sip.instance` value when it supplies one (RFC 5626 outbound). */
		instance: z.string().max(256).optional(),
		registeredAt: eventInstantSchema,
		/**
		 * When the granted interval lapses.
		 *
		 * The bucket's own TTL is an hour — longer than any sane `Expires:` — so an entry can be
		 * PRESENT and lapsed. A reader that treats presence as "registered" will show a phone that
		 * has been unplugged for fifty minutes as online; compare this against the clock.
		 */
		expiresAt: eventInstantSchema,
		/** The interval GRANTED, which is not always the one requested. */
		expiresInSeconds: z.int().min(0).max(86_400),
	})
	.loose();

export type RegistrationBinding = z.infer<typeof registrationBindingSchema>;

/** Whether a binding's granted interval has lapsed at `now` (epoch millis). */
export function isRegistrationLapsed(binding: RegistrationBinding, now: number): boolean {
	const expires = Date.parse(binding.expiresAt);
	// An unparseable deadline is treated as LAPSED, the opposite of the agent-state convention:
	// there the cost of being wrong is a call not offered, here it is a wallboard claiming a device
	// is up. Overstating availability is the more expensive lie in an incident.
	return Number.isNaN(expires) || now >= expires;
}

// ---------------------------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------------------------

/**
 * The teardown tail of `packages/telephony`'s channel machine.
 *
 * Only these three are named here, and the full thirteen-state vocabulary deliberately is not.
 * `packages/events` must not depend on `packages/telephony` — the backbone contract is the bottom
 * of the dependency graph on purpose — so any list copied here is a list that can drift. The
 * teardown tail is the one part a live-operations reader has to act on ("is this leg still up?"),
 * it is one-way, and it has been three states in every switch since Q.931. Copying the other ten
 * would buy a reader nothing it does not get from rendering the string.
 */
export const LIVE_CHANNEL_TEARDOWN_STATES = ["hangup", "reporting", "destroyed"] as const;
export type LiveChannelTeardownState = (typeof LIVE_CHANNEL_TEARDOWN_STATES)[number];

/** Which way the leg was set up. Mirrors `packages/telephony`'s `CHANNEL_DIRECTIONS`. */
export const LIVE_CHANNEL_DIRECTIONS = ["inbound", "outbound"] as const;
export type LiveChannelDirection = (typeof LIVE_CHANNEL_DIRECTIONS)[number];

/**
 * One live leg, as the `channels` bucket holds it.
 *
 * The AUTHORITY for this value is `packages/telephony`'s `ChannelSnapshot`, which the engine
 * writes verbatim. This schema is the READER's half: the fields a live-operations surface acts on,
 * validated, with everything else passed through untouched by `.loose()`.
 *
 * Timestamps are epoch MILLISECONDS here and ISO strings everywhere else on the backbone. That is
 * not an inconsistency to be tidied away — it is `ChannelSnapshot`'s existing shape, chosen so the
 * value survives `JSON.parse` without a reviver on the engine's hottest path, and re-encoding it at
 * the border would mean the bucket held one thing and this contract described another.
 */
export const liveChannelSchema = z
	.object({
		channelId: z.string().min(1),
		/** Groups the A-leg and every leg originated for it. */
		callId: z.string().min(1),
		organizationId: z.string().min(1),
		direction: z.enum(LIVE_CHANNEL_DIRECTIONS),
		/** `packages/telephony` `ChannelState`. Open, per {@link LIVE_CHANNEL_TEARDOWN_STATES}. */
		state: z.string().min(1).max(64),
		/** `packages/telephony` `CallState`; left open because it is the engine's own vocabulary. */
		callState: z.string().max(64).optional(),
		flags: z.array(z.string().max(48)).max(32).default([]),
		/**
		 * Caller identity as the engine resolved it. Loose, because `CallerProfile` carries more
		 * than a wallboard reads (an ANI, an RDNIS, a routing context) and the extra fields must
		 * survive the trip.
		 */
		profile: z
			.object({
				callerIdNumber: z.string().max(128).optional(),
				callerIdName: z.string().max(128).optional(),
				destinationNumber: z.string().max(128).optional(),
				channelName: z.string().max(256).optional(),
			})
			.loose()
			.optional(),
		/** The bridge this leg is part of, when bridged. Two legs sharing one are talking. */
		bridgeId: z.string().max(128).optional(),
		createdAt: z.number(),
		answeredAt: z.number().optional(),
		hangupAt: z.number().optional(),
		hangupCause: z.string().max(48).optional(),
	})
	.loose();

export type LiveChannel = z.infer<typeof liveChannelSchema>;

const TEARDOWN_SET: ReadonlySet<string> = new Set<string>(LIVE_CHANNEL_TEARDOWN_STATES);

/**
 * Whether a leg is still up.
 *
 * Both the state and `hangupAt` are checked, because the engine sets them in one write and a value
 * caught mid-flight with one and not the other must read as gone rather than as live. The bucket's
 * six-hour TTL means a leaked entry can outlive a shift, so "the key exists" is never the question
 * worth asking — which is exactly the mistake an active-calls tile is most likely to make.
 */
export function isLiveChannel(channel: LiveChannel): boolean {
	return !TEARDOWN_SET.has(channel.state) && channel.hangupAt === undefined;
}
