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
		/**
		 * EVERY live contact for this AOR, when the registrar tracks more than one.
		 *
		 * ## Why this is additive and why the flat fields above stay
		 *
		 * One AOR routinely has several devices: a desk phone and a softphone registered as the same
		 * extension is the normal case, not an edge one, and until this field existed the second
		 * REGISTER simply overwrote the first — so a call rang whichever handset had refreshed most
		 * recently, and the other was invisible.
		 *
		 * Adding contacts could have been done by REPLACING `contact` / `transport` / `sourceAddress`
		 * with this array, and that would have been the tidier shape and the wrong change. Three
		 * readers across two languages already consume the flat fields, and a value shape that
		 * arrives before every reader has been taught about it is a registration that reads as
		 * unregistered — a phone that cannot be called, produced by a deploy ordering detail. So the
		 * flat fields REMAIN and describe the PRIMARY contact, this array is optional, and a reader
		 * that has never heard of it behaves exactly as it did before.
		 *
		 * The registrar keeps the two in step by construction: the primary is `contacts[0]` and its
		 * fields are copied outward on every write. A value where they disagree is a bug in the
		 * writer, and a reader should trust the flat fields, because they are the ones every reader
		 * has always used.
		 *
		 * ## What the engine does with it
		 *
		 * Forks. One `originate` per contact, raced by `dialSimultaneous` exactly as a ring group is
		 * raced — one channel id, one `ChannelAggregate` and therefore one CDR row per attempt, with
		 * the losers getting `LOSE_RACE`. The SIP edge deliberately does NOT fork: it reports the
		 * contacts and the engine, which has the accounting and the confirmation flow, does the rest.
		 */
		contacts: z
			.array(
				z
					.object({
						/** The contact URI as the device offered it. Same caveats as the flat `contact`. */
						contact: z.string().min(1).max(1024),
						transport: sipTransportSchema,
						userAgent: z.string().max(256).optional(),
						sourceAddress: z.string().max(128).optional(),
						deviceId: z.string().max(64).optional(),
						/**
						 * The device's `+sip.instance` (RFC 5626), which is what makes a contact STABLE
						 * across re-registrations from a changing port. Where a device supplies one it is
						 * the identity a `{kind:"aor"}` originate should name; where it does not, the URI is.
						 */
						instance: z.string().max(256).optional(),
						registeredAt: eventInstantSchema,
						expiresAt: eventInstantSchema,
					})
					.loose(),
			)
			// Ten. A single AOR with more than ten live bindings is a misconfigured provisioning run or
			// a device in a REGISTER loop, and forking to eleven endpoints is not a feature anybody
			// asked for — it is a way to ring an entire office from one call.
			.max(10)
			.optional(),
	})
	.loose();

export type RegistrationBinding = z.infer<typeof registrationBindingSchema>;

/**
 * Every live contact for a binding, oldest shape included.
 *
 * The one function a caller should use, so "does this binding have a contacts array" is asked once
 * rather than at every call site: a binding written before the array existed yields its single flat
 * contact, and one written after yields the whole list.
 */
export function contactsOf(
	binding: RegistrationBinding,
): readonly { contact: string; transport: RegistrationBinding["transport"] }[] {
	if (binding.contacts !== undefined && binding.contacts.length > 0) {
		return binding.contacts;
	}
	return [{ contact: binding.contact, transport: binding.transport }];
}

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

// ---------------------------------------------------------------------------------------------
// media-sessions — which mediad instance holds which RTP session
// ---------------------------------------------------------------------------------------------

/**
 * One entry in the `media-sessions` KV directory.
 *
 * ## The question it answers, and why nothing else could
 *
 * `rpc.media.v1.*` is served by a QUEUE GROUP, so NATS hands each request to whichever `mediad`
 * happens to be free. That is right for `allocate-session` — any instance with a free port will do
 * — and wrong for every command after it, because a session lives on exactly ONE instance: its
 * sockets are bound there and its relay goroutines run there. A `bridge-sessions` delivered to the
 * neighbour has nothing to bridge.
 *
 * Two designs were on the table (`plans/mediad-design.md` open question 2). Carrying an
 * instance-specific reply subject and having the engine address it thereafter is simpler and needs
 * no lookup, but it puts routing state in the engine, where an engine restart loses it and every
 * live call becomes uncommandable. This directory survives that: any instance, and any engine, can
 * ask "who owns session X?" and get the same answer.
 *
 * It is also the substrate open question 3 (real graceful drain) will need, which is the second
 * reason it wins: draining means MOVING sessions, and you cannot move what you cannot enumerate.
 *
 * ## Why it is a directory and not a claim
 *
 * `park-claims` and `conference-claims` exist to make a race have exactly one winner, so they carry
 * an expiry and are taken with `create`. Nothing races for a media session: `mediad` allocated it,
 * `mediad` owns it, and the entry is a statement of fact written after the fact. So there is no
 * `expiresAt` and no heartbeat — the bucket's TTL is the only backstop, and the real cleanup is the
 * `release-session` handler deleting the key.
 *
 * ## Why the key is the session id alone
 *
 * The one other bucket not scoped by organization is `did-index`, for the same reason: the READER
 * does not know the tenant. A `mediad` handed a `bridge-sessions` carrying two session ids has no
 * org to scope a lookup with, and threading one through every command so the directory could be
 * org-prefixed would be adding a field to the wire to satisfy a key format. The org travels in the
 * value instead, where a reader that needs it has it.
 *
 * `.loose()`, like every other KV contract here: a value written by a process on its own release
 * cadence must not be rejected for carrying a field this reader has not heard of.
 */
export const mediaSessionDirectoryEntrySchema = z
	.object({
		sessionId: z.string().min(1).max(128),
		/** The `mediad` process that owns it. THE field this bucket exists for. */
		instanceId: z.string().min(1).max(128),
		orgId: z.string().min(1).max(128),
		callId: z.string().min(1).max(128),
		legId: z.string().max(128).optional(),
		/** The advertised address and port — what went into the SDP answer's `c=`/`m=` lines. */
		address: z.string().min(1).max(64),
		rtpPort: z.number().int().min(1).max(65_534),
		rtcpPort: z.number().int().min(1).max(65_535),
		/** The codec the answer settled on, so a reader can tell what the session is carrying. */
		codec: z.string().max(32).optional(),
		/**
		 * The relay this session is part of, when bridged.
		 *
		 * Present here as well as in `mediad`'s memory because it is what makes a bridge visible to
		 * anything that is not the owning instance — an operator asking "who is this call talking
		 * to", and eventually a drain that has to rebuild the relay on its new home.
		 */
		bridgeId: z.string().max(128).optional(),
		allocatedAt: z.number(),
	})
	.loose();

export type MediaSessionDirectoryEntry = z.infer<typeof mediaSessionDirectoryEntrySchema>;

// ---------------------------------------------------------------------------------------------
// sip-dialogs — which sipd instance holds which dialog, and until when
// ---------------------------------------------------------------------------------------------

/**
 * One entry in the `sip-dialogs` KV bucket.
 *
 * ## A claim, not a directory — and the difference is the lease
 *
 * `mediaSessionDirectoryEntrySchema` above carries no expiry, and its note says why: "nothing races
 * for a media session". Something races here, and it is not two writers — it is a REAPER against a
 * corpse. A dialog's sockets, timers and CSeq are local to one process (`plans/sipd-invite-design.md`
 * §6.1), so when a `sipd` dies its calls die with it and nothing can fail them over. What must not
 * also die is the ENGINE's knowledge that they ended: without it the engine holds channels for calls
 * that ended when a pod was rescheduled, and no CDR is ever written for any of them.
 *
 * So the record carries a lease its owner heartbeats, exactly as a park claim does, and a surviving
 * instance that finds an expired claim publishes `dialog.terminated{reason: "instance-lost"}` on the
 * dead owner's behalf. **The engine writes a CDR from a `leg-ended` it would otherwise never have
 * received.** That is the entire job. It is not failover and must not be mistaken for it.
 *
 * ## Why {@link expiresAt} rather than the bucket's TTL
 *
 * The same argument `PARK_CLAIMS_KV` makes: server-side expiry cannot tell "the owner stopped
 * heartbeating" from "this was written a long time ago and is still correct". A six-hour call would
 * be reaped by a TTL and must not be; a thirty-second-dead instance must be reaped and a TTL would
 * not notice for hours. The lease is what a reaper reads; the bucket TTL is a backstop for keys
 * nobody ever cleaned up at all.
 *
 * ## Its own expired claim is NOT reapable by its owner
 *
 * Worth stating on the contract because it is the one rule a reaper gets wrong. A `sipd` that finds
 * its OWN claim expired has a late heartbeat, not a dead call — the process is plainly alive, it is
 * running the sweep — and terminating its own live calls because the broker was slow would turn a
 * network blip into dropped calls. Only another instance's expired claim is an orphan.
 *
 * `.loose()`, like every other KV contract here.
 */
export const sipDialogClaimSchema = z
	.object({
		/** The key, repeated in the value. One string names the leg, the dialog and the RTP session. */
		legId: z.string().min(1).max(128),
		/** The `sipd` process that holds it. THE field this bucket exists for. */
		instanceId: z.string().min(1).max(128),
		/** Present once admission resolved it. Absent for the window before the engine answered. */
		orgId: z.string().max(128).optional(),
		callId: z.string().max(128).optional(),
		/** `uas` when we answered the INVITE, `uac` when we placed it. */
		role: z.enum(["uas", "uac"]),
		/** The dialog triple. A LOOKUP KEY and never an authorisation. */
		sipCallId: z.string().min(1).max(256),
		localTag: z.string().max(128).optional(),
		remoteTag: z.string().max(128).optional(),
		/** `early` before a 2xx, `confirmed` after the ACK, `terminating` on the way out. */
		state: z.string().min(1).max(32),
		/** The observed peer, `host:port` — the address that actually works. */
		remoteAddress: z.string().max(128).optional(),
		transport: sipTransportSchema.optional(),
		/** Set when the dialog is a carrier's. Absent for a registered endpoint. */
		trunkId: z.string().max(128).optional(),
		/** The trust boundary the dialog arrived on, so a reaped call's record says which. */
		profile: z.string().max(64).optional(),
		/** Epoch millis, as `channels` and `media-sessions` do it. */
		createdAt: z.number(),
		/** The lease. See the note above on why this is not the bucket's TTL. */
		expiresAt: z.number(),
	})
	.loose();

export type SipDialogClaim = z.infer<typeof sipDialogClaimSchema>;

/** Whether a claim's lease has lapsed at `now` (epoch millis). */
export function isSipDialogClaimExpired(claim: SipDialogClaim, now: number): boolean {
	return now >= claim.expiresAt;
}

/**
 * The claims that belong to some OTHER instance and whose lease has lapsed.
 *
 * Deliberately not "every expired claim" — see the rule on {@link sipDialogClaimSchema} about an
 * instance's own late heartbeat. Exported from the contract package rather than reimplemented in Go
 * and TypeScript because a reaper that got this predicate wrong would drop live calls, and one
 * definition cannot disagree with itself.
 */
export function orphanedSipDialogClaims(
	claims: readonly SipDialogClaim[],
	instanceId: string,
	now: number,
): readonly SipDialogClaim[] {
	return claims.filter(
		(claim) => claim.instanceId !== instanceId && isSipDialogClaimExpired(claim, now),
	);
}

// ---------------------------------------------------------------------------------------------
// trunks — the carrier directory the SIP edge dials
// ---------------------------------------------------------------------------------------------

/**
 * One entry in the `trunks` KV bucket: a `trunk` row, reduced to what it takes to place a call.
 *
 * A DERIVED read model. `pbx-db`'s `trunk` table is the authority and this is rebuildable from it at
 * any time, exactly as `did-index` is — the same shape, the same writer (`apps/api`, inside the unit
 * of work that changed the row) and the same repair path.
 *
 * ## What is deliberately not here
 *
 * **The secret.** {@link secretRef} is a handle into the secret manager, precisely as `sipSecretRef`
 * is in the column, and the password it names never lands on the broker. A read model that carried
 * credentials would put every tenant's carrier password in a bucket four services can open.
 *
 * **`codecPrefs`.** It is on the row and it is ADVISORY until the media plane can serve more than
 * G.711 (`plans/sipd-invite-design.md` §5.2): `mediad` writes every offer, and the SIP edge holds no
 * codec knowledge in either direction. Carrying a preference the edge cannot act on would invite the
 * edge to act on it.
 *
 * **Status.** Reachability changes on a timer and configuration does not. It travels as
 * `trunk.evt.v1.…status.changed`, which is an event precisely because it is a transition, and the
 * persisted view is the `trunk.status*` columns.
 */
export const trunkDirectoryEntrySchema = z
	.object({
		trunkId: z.string().min(1).max(128),
		orgId: z.string().min(1).max(128),
		/** The `trunk.name` column — what a dial template used to substitute, kept for the log. */
		name: z.string().min(1).max(128),
		/** `register` means we REGISTER to the carrier; `ip-auth` means it authenticates our source IP. */
		kind: z.enum(["register", "ip-auth"]),
		/** SIP domain for `From`/`To`; usually the carrier's realm. */
		sipDomain: z.string().min(1).max(255),
		/** Where INVITEs go. */
		sipProxy: z.string().min(1).max(255),
		/** A pre-loaded route, when the carrier fronts its proxy with an SBC. */
		outboundProxy: z.string().max(255).optional(),
		authUser: z.string().max(128).optional(),
		/** A HANDLE, never a password. See the note above. */
		secretRef: z.string().max(256).optional(),
		transport: sipTransportSchema,
		registerExpiresSeconds: z.int().min(30).max(86_400).default(300),
		/**
		 * The concurrency cap. Enforced at the EDGE as well as in the engine, and the duplication is
		 * deliberate: the engine's check happens before it offers a call to this trunk, and the edge's
		 * is what stands between a carrier and a runaway loop that never consulted the engine at all.
		 */
		maxChannels: z.int().min(1).max(10_000).optional(),
		callerIdNumberOverride: z.string().max(64).optional(),
		/** A disabled trunk stays in the bucket and is not dialled. Removal is a DELETE. */
		enabled: z.boolean().default(true),
		updatedAt: z.number(),
	})
	.loose();

export type TrunkDirectoryEntry = z.infer<typeof trunkDirectoryEntrySchema>;

// ---------------------------------------------------------------------------------------------
// sip-acl — the networks the edge accepts unauthenticated traffic from
// ---------------------------------------------------------------------------------------------

/** What an ACL entry governs. Mirrors `pbx-db`'s `sip_acl_entry.scope`. */
export const SIP_ACL_SCOPES = ["registration", "trunk", "provisioning", "api"] as const;
export type SipAclScope = (typeof SIP_ACL_SCOPES)[number];

/**
 * One entry in the `sip-acl` KV bucket.
 *
 * ## Why a read model rather than a query
 *
 * `sip_acl_entry` is organization-scoped and the reader is not: an INVITE from a carrier arrives
 * carrying a source address and nothing else. Same problem as `did-index`, same answer — a derived,
 * non-org-scoped bucket written by `apps/api` from the table.
 *
 * And the edge WATCHES it, compiling the entries into an in-process longest-prefix match, rather
 * than doing a get per INVITE. A get per INVITE is a broker round trip inside a SIP transaction on
 * the one code path an attacker controls the rate of.
 *
 * ## Evaluation order is part of the contract
 *
 * Lowest {@link priority} first; ties broken by the most specific prefix; `deny` and `allow` are
 * both real verdicts and the first match wins. **An address matching nothing is REFUSED** — the
 * allow-list rule the broker's own permissions follow, and the only default that is safe on a
 * boundary whose whole job is that unauthenticated traffic never resolves in a trunk-capable
 * context.
 *
 * ## Why {@link trunkId} is here
 *
 * `pbx-db`'s `trunk` table has `kind: "ip-auth"` — "the carrier authenticates our source IP" — and
 * NO field for which source addresses we accept, while `sip_acl_entry` has the networks and no idea
 * which trunk they belong to. Carrying the association here is what lets a matched packet be
 * attributed to a carrier, which is what puts a `trunkId` on the admission request and ultimately a
 * trunk on the CDR. Absent means the entry admits without attributing.
 */
export const sipAclEntrySchema = z
	.object({
		/** The network in CIDR form, e.g. `203.0.113.0/24`. The key is this, dots and slash folded. */
		network: z.string().min(1).max(64),
		orgId: z.string().min(1).max(128),
		action: z.enum(["allow", "deny"]),
		scope: z.enum(SIP_ACL_SCOPES),
		/** Lowest first. See the evaluation-order note above. */
		priority: z.int().min(0).max(65_535).default(100),
		/** The carrier this network belongs to, when the entry attributes one. */
		trunkId: z.string().max(128).optional(),
		/** The admin's own label, so a refusal log names the rule a human wrote. */
		name: z.string().max(128).optional(),
		/** A disabled entry stays in the bucket and does not match. Removal is a DELETE. */
		enabled: z.boolean().default(true),
		updatedAt: z.number(),
	})
	.loose();

export type SipAclEntry = z.infer<typeof sipAclEntrySchema>;

// ---------------------------------------------------------------------------------------------
// presence — the value a busy-lamp key renders
// ---------------------------------------------------------------------------------------------

/**
 * The device-state vocabulary, copied from `packages/telephony`'s `DEVICE_STATES`.
 *
 * ## Why this list is copied rather than open
 *
 * `liveChannelSchema.state` above is deliberately left as an open string, on the rule that
 * `packages/events` must not depend on `packages/telephony` and a copied list is a list that can
 * drift. This one is copied anyway, and the difference is what the READER does with it.
 *
 * A wallboard renders a channel state as text, so an unknown value degrades to "a word I have not
 * seen". `apps/sipd` MAPS a device state onto an RFC 4235 `dialog-info+xml` body, and there is no
 * degradation available: an unrecognised state is a `NOTIFY` it cannot compose, which is a lamp
 * stuck on whatever it last showed. A closed vocabulary is the only shape a mapper can be total
 * over.
 *
 * It is also the list least likely to move: seven values, frozen by
 * `plans/reference/freeswitch-capabilities.md` §1, unchanged in FreeSWITCH for a decade. The copy is
 * pinned against the original by a spec in `apps/engine`, which is the one place that legitimately
 * imports both packages.
 */
export const PRESENCE_DEVICE_STATES = [
	"down",
	"ringing",
	"active",
	"active-multi",
	"held",
	"unheld",
	"hangup",
] as const;

export type PresenceDeviceState = (typeof PRESENCE_DEVICE_STATES)[number];

/**
 * One extension's aggregated device state, as the `presence` bucket holds it.
 *
 * ## Where it comes from, and why last-write-wins is safe
 *
 * The engine derives this from the `channels` bucket — the same {@link liveChannelSchema} values it
 * already mirrors every leg into — and NOT from any one instance's in-memory registry. That choice
 * is what makes the write semantics trivial:
 *
 *  - `channels` is SHARED, so every engine instance watching it sees the same legs and computes the
 *    same aggregate. Concurrent writers do not disagree; they are redundant. Last-write-wins over
 *    identical values is not a conflict.
 *  - An instance that starts, restarts or is rescheduled rebuilds the whole picture from the
 *    bucket's replay, so presence heals itself rather than needing a handover.
 *  - The alternative — each instance contributing the legs it happens to hold, merged under
 *    compare-and-swap — needs per-instance shares in the value and needs dead instances' shares aged
 *    out. It buys nothing when the input is already global.
 *
 * ## Debounce, and what "last write" means
 *
 * Writers debounce on VALUE, not on time: an instance writes only when the aggregate it computed
 * differs from the one it last wrote for that extension. A leg moving `ringing → active` is one
 * write; a leg moving `active → active` (a bridge change, a variable set, a KV mirror of an
 * unrelated field) is none. A reader can therefore treat every revision as a real transition, which
 * is what lets `sipd` turn one KV update into exactly one NOTIFY.
 *
 * Deletion is meaningful and is not the same as `down`. The engine deletes the key when an extension
 * has no live channels at all, so a lamp is cleared by the key's ABSENCE as well as by a `down`
 * value; a reader must handle both, because the bucket's five-minute TTL produces the first
 * unprompted.
 *
 * ## What it is not
 *
 * Not registration state. An extension whose phone is unplugged is `down` here, exactly as one whose
 * phone is idle is; "is that device even on the network" is the `registrations` bucket's question
 * and BLF has never answered it. Nor is it presence in the RFC 3856 sense — no availability, no
 * note, no human-set status. It is the dialog state of an extension's channels and nothing more.
 *
 * `.loose()`, like every other KV contract here.
 */
export const extensionPresenceSchema = z
	.object({
		orgId: z.string().min(1).max(128),
		/**
		 * The dialable number, e.g. `1001` — the KV key's second token, repeated in the value.
		 *
		 * The NUMBER and not the `extension` row id, and that is the one contract decision in this
		 * block worth arguing. Every provisioning template in `apps/api` writes a BLF key as a number:
		 * Yealink emits `linekey.N.value = 200`, Snom `blf sip:200@<domain>;user=phone`, Poly
		 * `attendant.resourceList.N.address="200@<domain>"`. A phone therefore SUBSCRIBEs to
		 * `sip:200@<domain>` and `sipd` has a number in its hand. Keying by row id would put a lookup
		 * — a database round trip or an RPC — on the path of every `SUBSCRIBE` and every `NOTIFY`,
		 * to translate an identifier the wire never carries. The engine is in the same position from
		 * the other side: a `ChannelSnapshot` carries `profile.destinationNumber`, never a row id.
		 *
		 * The cost is that renumbering an extension orphans its key. That is correct behaviour rather
		 * than a defect: the phones watching the old number are watching a number that no longer
		 * rings, and their lamps should go dark until they are reprovisioned.
		 */
		extensionNumber: z.string().min(1).max(64),
		/** What every channel of this extension collapses to. What a lamp renders. */
		state: z.enum(PRESENCE_DEVICE_STATES),
		/** How many live channels the aggregation saw. `0` whenever `state` is `down`. */
		channelCount: z.int().min(0).max(1024),
		/**
		 * The per-channel call states the aggregation collapsed, for diagnosis.
		 *
		 * Diagnosis is the whole justification: "why is 1001's lamp solid" is otherwise unanswerable
		 * from this bucket alone, and the alternative is joining against `channels` by hand at the
		 * moment somebody is complaining. Left as open strings for the same reason
		 * `liveChannelSchema.state` is — this is an INPUT the writer already consumed, not something
		 * a reader acts on.
		 */
		callStates: z.array(z.string().max(32)).max(64).optional(),
		/**
		 * The engine instance that last wrote this entry.
		 *
		 * Every instance computes the same value from the same shared input, so this is not part of
		 * the answer — it is how an operator tells which replica is still doing the writing when one
		 * of them has stopped.
		 */
		writtenBy: z.string().max(128).optional(),
		/** Epoch millis, as `channels` and `media-sessions` do it. */
		updatedAt: z.number(),
	})
	.loose();

export type ExtensionPresence = z.infer<typeof extensionPresenceSchema>;
