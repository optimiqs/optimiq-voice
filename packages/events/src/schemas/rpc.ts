import { z } from "zod";
import { RPC_SUBJECTS } from "../subjects";
import {
	callDirectionSchema,
	destinationTypeSchema,
	dialStringSchema,
	dtmfDigitSchema,
	hangupCauseSchema,
	sipTransportSchema,
	tapModeSchema,
	transferKindSchema,
} from "./telephony";

/**
 * Request-reply contracts for the `rpc.*` subjects (plan §3.5).
 *
 * These are CONTRACTS ONLY — subject plus a request/response schema pair. Transport is the
 * application's business: services expose them with NestJS `@MessagePattern` over the NATS
 * transport and call them with a `ClientProxy`. This package neither opens a connection nor
 * wraps one.
 *
 * `rpc.media.*` (engine → `mediad`) was deliberately absent while the media plane was a walking
 * skeleton. It is here now, as `rpc.media.v1.*`, because all four promotion criteria in
 * `plans/mediad-design.md` §4.3 are met: SDP is in the payloads, there is a real Go responder in
 * `apps/mediad/internal/control`, and there is a real TypeScript caller in the engine's
 * `MediadMediaPort`. **Read the note on {@link mediaAllocateSessionRequestSchema} before writing
 * either end** — this is the one subject family whose caller must NOT use a Nest `ClientProxy`.
 *
 * ## What is actually on the wire — read this before adding a responder
 *
 * A schema here describes the PAYLOAD. NestJS's NATS transport does not put the payload on the
 * wire for request-reply; it puts its own framing around it:
 *
 * ```text
 * request   {"pattern":"<subject>","data":{…the schema…},"id":"…"}
 * reply     {"response":{…the schema…},"isDisposed":true,"id":"…"}
 * ```
 *
 * and a request carrying the bare payload is **not answered at all** — it times out. That is
 * invisible while both ends are Nest (`@MessagePattern` ↔ `ClientProxy.send`), which is what every
 * subject above was when it was written, and `apps/engine/src/nats/envelope.serializer.ts` records
 * the same leak on the event side.
 *
 * It stops being invisible the moment a caller is not TypeScript. `packages/events-go` generates
 * request/response structs from these schemas, so a Go caller speaks the payload and nothing else.
 * `rpc.sip.v1.credential` therefore has a **raw** responder
 * (`apps/api/src/pbx/sip-credentials/sip-credentials.responder.ts`), not a `@MessagePattern` one.
 *
 * Rule of thumb: if a subject has, or could have, a non-TypeScript participant, serve it raw so
 * that the contract is the wire. If it is Nest-to-Nest, `@MessagePattern` is fine — but the
 * generated Go structs for it are then documentation, not a usable client.
 *
 * The `rpc.engine.v1.*` pair are the exceptions to the second half — Nest on both ends and raw
 * anyway, for two different reasons. `park-handoff`'s subject is not a constant, so no
 * `@MessagePattern` can express it. `originate`'s is, and it is raw because the engine already
 * serves its whole request-reply surface on one raw connection; adding a second transport for one
 * subject buys nothing. See each one's own note.
 */

/** A request-reply contract: one subject, one request schema, one response schema. */
export interface RpcContract<TRequest extends z.ZodType, TResponse extends z.ZodType> {
	readonly subject: string;
	readonly request: TRequest;
	readonly response: TResponse;
	/** Suggested client deadline. These are on the call path — slow is the same as broken. */
	readonly timeoutMs: number;
}

function defineRpc<TRequest extends z.ZodType, TResponse extends z.ZodType>(
	subject: string,
	request: TRequest,
	response: TResponse,
	timeoutMs: number,
): RpcContract<TRequest, TResponse> {
	return { subject, request, response, timeoutMs };
}

// ---------------------------------------------------------------------------------------------
// rpc.routing.v1.resolve — engine → api, on a routing-cache miss
// ---------------------------------------------------------------------------------------------

export const routingResolveRequestSchema = z.object({
	orgId: z.uuid(),
	direction: callDirectionSchema,
	destinationNumber: dialStringSchema,
	callerNumber: dialStringSchema.optional(),
	callerName: z.string().max(128).optional(),
	/**
	 * The named routing namespace the leg is executing in. This is the toll-fraud boundary from
	 * `plans/reference/freeswitch-capabilities.md` §7 — unauthenticated traffic never resolves in
	 * a trunk-capable context.
	 */
	routingContext: z.string().min(1).max(64),
	/** Present when the lookup is for a live call; used for logging correlation only. */
	callId: z.uuid().optional(),
	/**
	 * Evaluation instant. Time conditions (business hours, holidays) are first-class routing
	 * predicates, so a resolve is only reproducible against an explicit clock.
	 */
	at: z.iso.datetime().optional(),
});

export const routingResolveResponseSchema = z.object({
	matched: z.boolean(),
	destinationType: destinationTypeSchema.optional(),
	destinationRef: z.uuid().optional(),
	/** Context the call should continue in, when the rule moves it. */
	routingContext: z.string().max(64).optional(),
	/**
	 * The compiled routing artifact. Opaque here on purpose — `packages/routing` owns its shape,
	 * and the engine caches it verbatim under `cacheKey`.
	 */
	artifact: z.unknown().optional(),
	/** `routing-cache` KV key the engine should store `artifact` under (see `kvKeyFor`). */
	cacheKey: z.string().max(256).optional(),
	ttlMs: z.int().min(0).optional(),
	/** Why nothing matched, for the "call went nowhere" support ticket. */
	reason: z.string().max(256).optional(),
});

export type RoutingResolveRequest = z.infer<typeof routingResolveRequestSchema>;
export type RoutingResolveResponse = z.infer<typeof routingResolveResponseSchema>;

export const ROUTING_RESOLVE_RPC = defineRpc(
	RPC_SUBJECTS.routingResolve,
	routingResolveRequestSchema,
	routingResolveResponseSchema,
	2_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.authz.v1.check — any service → api
// ---------------------------------------------------------------------------------------------

export const authzCheckRequestSchema = z.object({
	orgId: z.uuid(),
	/**
	 * WHO is asking. Four kinds, and `extension` is the one that needs the argument.
	 *
	 * An extension looks like a resource — it is a row in `pbx-db` with a number on it, and every
	 * other subject on this platform is a principal with a user id. It is on this list anyway,
	 * because of what the engine actually has at the moment it needs an answer. A supervisor picks
	 * up a desk phone and dials `*0<extension>`. The engine authenticated that caller the only way a
	 * phone can be authenticated: the call arrived from a REGISTERED EXTENSION. There is no session,
	 * no cookie and no user id anywhere in the call — the same identity `*72` writes forwarding
	 * with, and the same one `*97` opens a mailbox with. A check keyed on `user` could therefore
	 * never be made from a handset at all, and the alternative to naming this subject type is that
	 * every feature reachable from a phone is either unauthorized or authorized by whichever
	 * runtime happens to be asking. That is the choice this entry closes.
	 *
	 * When `type` is `extension`, `id` is the extension NUMBER — not its uuid — scoped by `orgId`,
	 * because the number is what the engine holds and asking it to carry a primary key it never
	 * learned would put the resolution in the wrong process.
	 *
	 * And the number is a **CLAIM**, never an identity to be trusted, exactly as
	 * `rpc.pbx.v1.extension-feature` says of its own `extensionNumber`: a request on a shared broker
	 * proves only that something reached the broker. The responder must resolve the number to an
	 * extension row **inside the tenant's own scope**, then that row to its primary linked user,
	 * then that user's membership role, and answer on the permissions that produces. A responder
	 * that skipped a hop would be answering `allowed: true` for whatever number it was handed,
	 * which on THIS subject means handing a stranger the audio of somebody's live call.
	 */
	subject: z.object({
		type: z.enum(["user", "api-key", "service", "extension"]),
		id: z.string().min(1).max(128),
	}),
	/** `<resource>.<action>[.<scope>]` strings from the permission registry in `packages/auth`. */
	permissions: z
		.array(
			z
				.string()
				.min(1)
				.max(96)
				.regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, "permission must be dotted kebab-case"),
		)
		.min(1)
		.max(64),
	resource: z
		.object({ type: z.string().min(1).max(64), id: z.string().max(128).optional() })
		.optional(),
});

export const authzCheckResponseSchema = z.object({
	/** True only when EVERY requested permission is granted. */
	allowed: z.boolean(),
	granted: z.array(z.string().max(96)).max(64),
	missing: z.array(z.string().max(96)).max(64),
	reason: z.string().max(256).optional(),
});

export type AuthzCheckRequest = z.infer<typeof authzCheckRequestSchema>;
export type AuthzCheckResponse = z.infer<typeof authzCheckResponseSchema>;

export const AUTHZ_CHECK_RPC = defineRpc(
	RPC_SUBJECTS.authzCheck,
	authzCheckRequestSchema,
	authzCheckResponseSchema,
	1_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.voicemail.v1.list — engine → api, when a caller opens a mailbox
// ---------------------------------------------------------------------------------------------

/**
 * The read model behind the `*97` menu.
 *
 * Messages live in `pbx-db`'s `voicemail_message`, which is the control plane's table; the engine
 * holds no database handle and must not grow one, so a caller who has just authenticated needs a
 * request-reply to find out what is in their mailbox. Request-reply rather than an event stream
 * because the answer is needed *now*, at the moment the caller is listening to silence, and a
 * consumer-maintained projection would be a second copy of the same rows with its own staleness.
 *
 * The engine is expected to survive nobody answering. A mailbox it cannot list is announced as
 * unavailable and the call ends — never as "you have no messages", which is a different and much
 * more damaging thing to tell somebody who has nine.
 */
export const voicemailListRequestSchema = z.object({
	orgId: z.uuid(),
	voicemailBoxId: z.uuid(),
	/**
	 * The number the caller reached the mailbox from, as the engine authenticated it.
	 *
	 * The responder MUST treat this as a claim to be checked against the box, not as authorisation:
	 * the engine authenticates a caller with the box's PIN and its own extension check, but a
	 * responder that trusted a request purely because it arrived on the broker would hand any
	 * process on the network any tenant's messages.
	 */
	mailboxNumber: z.string().min(1).max(32),
	/** `new` is what the menu plays. `saved` and `deleted` are the other `voicemail_message` folders. */
	folder: z.enum(["new", "saved", "deleted"]).default("new"),
	/** Newest first, capped so one mailbox cannot produce an unbounded reply. */
	limit: z.int().min(1).max(100).default(20),
	callId: z.uuid().optional(),
});

export const voicemailMessageSummarySchema = z.object({
	messageId: z.uuid(),
	folder: z.enum(["new", "saved", "deleted"]),
	/** Object-storage key for the audio. The engine renders it as an `object://` media ref. */
	objectKey: z.string().min(1).max(1024),
	durationMs: z.int().min(0),
	receivedAt: z.iso.datetime(),
	callerIdNumber: z.string().max(64).optional(),
	callerIdName: z.string().max(128).optional(),
});

export const voicemailListResponseSchema = z.object({
	/** False means "this mailbox could not be read" — never "it is empty". */
	found: z.boolean(),
	/** Newest first. Empty with `found: true` is a genuinely empty folder. */
	messages: z.array(voicemailMessageSummarySchema).max(100).default([]),
	/** Total in the folder, which may exceed `messages.length` when `limit` truncated it. */
	total: z.int().min(0).default(0),
	newCount: z.int().min(0).default(0),
	savedCount: z.int().min(0).default(0),
	/** Why the mailbox could not be read, for the support ticket. */
	reason: z.string().max(256).optional(),
});

export type VoicemailListRequest = z.infer<typeof voicemailListRequestSchema>;
export type VoicemailListResponse = z.infer<typeof voicemailListResponseSchema>;
export type VoicemailMessageSummary = z.infer<typeof voicemailMessageSummarySchema>;

export const VOICEMAIL_LIST_RPC = defineRpc(
	RPC_SUBJECTS.voicemailList,
	voicemailListRequestSchema,
	voicemailListResponseSchema,
	// Longer than a routing resolve: this one is answered while the caller is already connected and
	// listening, so a slow reply costs a second of dead air rather than a call that never connects.
	3_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.pbx.v1.extension-feature — engine → api, when a handset presses `*72`/`*74`/`*76`/`*78`/`*21`
// ---------------------------------------------------------------------------------------------

/**
 * The self-service half of forwarding, do-not-disturb and follow-me.
 *
 * ## Why this is the only write the engine makes
 *
 * `extension.forward_all_enabled` and its four siblings are already compiled into every routing
 * artifact — the compiler resolves them into `forwardAllNodeId`, `busyNodeId` and `noAnswerNodeId`
 * and the walker has honoured them since the day extensions were compiled. What was missing was
 * the other direction: a user could only change them from the admin UI, so `*72` announced itself
 * as unimplemented on a system that already routed forwarding perfectly.
 *
 * The columns live in `pbx-db`, which the API owns and the engine has no handle on, so the press
 * has to become a request. FusionPBX did the same thing through ESL ("call forward/DND writes
 * extension flags", frozen inventory §Features); this is that seam with a schema on it.
 *
 * ## `extensionNumber` is a claim, exactly as `mailboxNumber` is
 *
 * The engine knows which extension dialled because the call arrived from it, and that is as strong
 * as the phone on the desk — the same authentication `*97` accepts. It is NOT authorization: a
 * request on the broker proves only that something reached the broker. The responder therefore
 * resolves the number inside `withTenantScope(orgId)` and refuses a number that is not an enabled
 * extension of that organization, rather than writing whatever row it is handed.
 *
 * ## `enabled: false` never clears the destination
 *
 * The columns are a flag/destination pair precisely so switching forwarding off does not lose the
 * number the user configured — see `extensions-schema.ts`. A clear therefore writes the flag and
 * leaves the destination alone, which is what makes `*72` followed later by a bare `*72` a toggle
 * rather than a re-typing exercise.
 *
 * ## The reply is what the caller HEARS
 *
 * `applied` decides between the confirmation tone and the "unavailable" announcement, so a refusal
 * must arrive as a reply rather than as a timeout: a user who is told nothing assumes forwarding is
 * on, and the person who then rings them is the one who finds out it is not. `reason` is for the
 * log; the handset is never told which of the refusals happened.
 */
export const extensionFeatureSchema = z.enum([
	"forward-all",
	"forward-busy",
	"forward-no-answer",
	"do-not-disturb",
	"follow-me",
]);

export const extensionFeatureRequestSchema = z.object({
	orgId: z.uuid(),
	/** The calling extension's number, as the engine authenticated it. A claim — see above. */
	extensionNumber: z.string().min(1).max(32),
	feature: extensionFeatureSchema,
	/** The state being asked for. `false` clears the flag and keeps the stored destination. */
	enabled: z.boolean(),
	/**
	 * Where to forward, for the three forwarding features when `enabled` is true.
	 *
	 * Ignored by `do-not-disturb` and `follow-me`, which have no destination of their own: a
	 * ladder's hops are configured from the admin UI and `*21` only flips its switch.
	 */
	destination: dialStringSchema.optional(),
	/** Present when the change came off a live call; for logging correlation only. */
	callId: z.uuid().optional(),
});

export const extensionFeatureResponseSchema = z.object({
	/** False means nothing was written. The handset hears the unavailable announcement. */
	applied: z.boolean(),
	feature: extensionFeatureSchema,
	/** The state AFTER the write, or the state as it still stands when `applied` is false. */
	enabled: z.boolean().default(false),
	/** The stored destination after the write, when the feature has one. */
	destination: z.string().max(128).optional(),
	/** Why the change was refused, for the support ticket. Never played to the handset. */
	reason: z.string().max(256).optional(),
});

export type ExtensionFeature = z.infer<typeof extensionFeatureSchema>;
export type ExtensionFeatureRequest = z.infer<typeof extensionFeatureRequestSchema>;
export type ExtensionFeatureResponse = z.infer<typeof extensionFeatureResponseSchema>;

export const EXTENSION_FEATURE_RPC = defineRpc(
	RPC_SUBJECTS.pbxExtensionFeature,
	extensionFeatureRequestSchema,
	extensionFeatureResponseSchema,
	// The longest deadline in this file, and the only one that covers a WRITE. The responder does
	// not just update a column: it recompiles the tenant's whole routing artifact inside the same
	// transaction (compile-on-write), because a `*72` whose artifact still says "ring the desk" is
	// a `*72` that did not happen. A caller listening to a moment of silence before the
	// confirmation tone is a far better outcome than a confirmation that outran the change.
	5_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.pbx.v1.last-caller — engine → api, when a handset presses `*69`
// ---------------------------------------------------------------------------------------------

/**
 * `*69` — call the last person who rang me back.
 *
 * ## Why the CDR and not a KV projection
 *
 * The engine sees every inbound leg, so it could keep its own "last caller" bucket. It should not:
 * that bucket would be a second copy of a fact `cdr-db.call_legs` already stores durably, it would
 * be empty after a restart or a rebalance, and it would have to be written on the call path for a
 * feature pressed once a week. `call_legs` already carries `(organization_id, to_number)` as an
 * index and `started_at` as its partition key, so the newest inbound leg towards an extension is
 * one bounded index scan.
 *
 * FreeSWITCH backs `*69` with its own key-value store (frozen reference §Other capabilities). This
 * is the same fact sourced from the ledger that was going to record it anyway.
 *
 * ## Bounded in time, always
 *
 * `call_legs` is partitioned by `started_at`, so an unbounded "most recent" query is a scan of
 * every partition that exists. `withinHours` bounds it, and a lookup that finds nothing inside the
 * window answers `found: false` rather than reaching further back — a `*69` that dials somebody
 * from three months ago is a wrong number, not a feature.
 */
export const lastCallerRequestSchema = z.object({
	orgId: z.uuid(),
	/** The calling extension's number, as the engine authenticated it. A claim, as above. */
	extensionNumber: z.string().min(1).max(32),
	/** How far back to look. Bounded because the leg table is partitioned by time. */
	withinHours: z.int().min(1).max(720).default(168),
	callId: z.uuid().optional(),
});

export const lastCallerResponseSchema = z.object({
	/** False means "nobody rang this extension inside the window", or that the lookup failed. */
	found: z.boolean(),
	/** The number to dial back. Absent with `found: true` means the caller withheld their number. */
	callerNumber: dialStringSchema.optional(),
	callerName: z.string().max(128).optional(),
	/** When that leg started, ISO 8601. For the log and the walk's notes. */
	at: z.iso.datetime().optional(),
	reason: z.string().max(256).optional(),
});

export type LastCallerRequest = z.infer<typeof lastCallerRequestSchema>;
export type LastCallerResponse = z.infer<typeof lastCallerResponseSchema>;

export const LAST_CALLER_RPC = defineRpc(
	RPC_SUBJECTS.pbxLastCaller,
	lastCallerRequestSchema,
	lastCallerResponseSchema,
	// The same budget the mailbox listing gets, for the same reason: the caller is already
	// connected and a slow reply costs dead air rather than a call that never connected.
	3_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.pbx.v1.file-greeting — engine → api, when a handset finishes recording over `*99`
// ---------------------------------------------------------------------------------------------

/**
 * Which of a mailbox's greetings a recording occupies.
 *
 * The same four slots `voicemail_greeting.kind` has, restated here rather than imported: this
 * package is the contract and must not depend on the control plane's schema package, and a Go
 * caller gets the enum from the generated code rather than from a Drizzle table. `*99` records
 * `unavailable` today — the catalogue's `voicemail-record-greeting` takes no argument — and the
 * other three are on the wire so that a second code, or an argument, does not need a new subject.
 */
export const VOICEMAIL_GREETING_KINDS = ["unavailable", "busy", "name", "temporary"] as const;
export const voicemailGreetingKindSchema = z.enum(VOICEMAIL_GREETING_KINDS);
export type VoicemailGreetingKind = (typeof VOICEMAIL_GREETING_KINDS)[number];

/**
 * `*99` — filing the greeting a user has just recorded from their handset.
 *
 * ## Why this is not `voicemail.message.left`
 *
 * The engine already has a way to say "I recorded audio for this mailbox", and it is deliberately
 * NOT reused. `voicemailMessageLeftData` files a row in `voicemail_message`, archives the audio and
 * publishes `mwi.updated` — so a greeting sent down that path would land in the recorder's own
 * inbox and light their lamp, and the mailbox would still answer with the deployment's default
 * announcement. The two look alike at the microphone and are opposite facts afterwards: a message
 * is something a mailbox RECEIVED, a greeting is what it SAYS.
 *
 * ## Why request-reply and not an event
 *
 * Filing a greeting is a two-row write — clear the incumbent active greeting of that kind, insert
 * the new one — inside a recompile, because `voicemail_greeting` is a routing input and the
 * compiler embeds the active recording into the mailbox's `leave` node.
 * `voicemail-greetings.service.ts` sets out at length why those statements cannot be split. An
 * event would give the engine no way to know whether any of it happened, and `*99`'s whole design
 * rests on the opposite: the port is checked BEFORE the beep, and the confirmation is played only
 * once the greeting is filed. A user who is told their greeting is live when it is not discovers it
 * from the first caller who reaches the mailbox, which is the one outcome the runtime exists to
 * prevent.
 *
 * ## `mailboxNumber` is a claim, exactly as it is on `rpc.voicemail.v1.list`
 *
 * The engine knows which mailbox because the call came from the extension that owns it and the
 * box's PIN gate — the same one `*97` applies — was satisfied. That is authentication of the
 * strength of the phone on the desk, and it is not authorization: a request on a shared broker
 * proves only that something reached the broker. So the responder loads the box under
 * `withTenantScope(orgId)` and refuses a box whose own `mailbox_number` is not the claimed one,
 * rather than replacing the greeting of whatever id it is handed.
 *
 * ## THE AUDIO IS A KEY, NOT BYTES
 *
 * This is the shape decision worth the paragraph. The request carries `objectKey` — the recording's
 * key relative to the shared object root, `<orgId>/<callId>/<recordingId>.<ext>`, exactly as
 * `voicemailMessageLeftData.objectKey` carries a message's and exactly what
 * `mediaStartRecordingResponse.objectKey` defines. Three reasons, in the order they bite:
 *
 * 1. **The engine never holds the bytes.** The media server writes the file itself, straight onto
 *    the mount every process in the deployment shares (`media-storage.ts` has the whole picture);
 *    the engine only ever learns a name for it. A payload of audio would mean the call path reading
 *    a file off disk purely to hand it back to a process that can already open it.
 * 2. **NATS request-reply is not a file transport.** A minute of 8 kHz PCM is most of a megabyte,
 *    which is a broker's default maximum payload; the ceiling would be reached by a greeting a
 *    user is entitled to record, and the failure would arrive as a disconnect rather than a
 *    refusal.
 * 3. **The key is already the vocabulary.** The recording has a `channel.record.started` /
 *    `channel.record.stopped` pair carrying the same key, so the greeting, the CDR's recording row
 *    and the archive all name one object rather than three copies of one sound.
 *
 * What the responder does with it is an INGEST rather than a rename: it reads the object, checks
 * that it really is audio, and writes a copy under the media library's own layout
 * (`greetings/<org>/<box>/<greetingId>.<ext>`), because that is where the compiler expects a
 * greeting to live and where the greeting's HTTP lifecycle — preview, relabel, delete — can reach
 * it. A copy and not a move: the source object is still what `channel.record.stopped` named, and
 * moving it would break the recording row that names it.
 *
 * ## The reply is what the caller HEARS
 *
 * `applied` decides between the confirmation and the "not available" announcement, so a refusal
 * must arrive as a reply rather than as a timeout — the same rule `rpc.pbx.v1.extension-feature`
 * states, and it costs more here: the user has just spent thirty seconds recording, and silence
 * would leave them believing it worked.
 */
export const fileGreetingRequestSchema = z.object({
	orgId: z.uuid(),
	/** The box the walk resolved from the artifact's mailbox table. Re-checked against the claim. */
	voicemailBoxId: z.uuid(),
	/** The mailbox number the walk authenticated. A CLAIM — see above. */
	mailboxNumber: z.string().min(1).max(32),
	/**
	 * Minted by the engine, and it becomes the `voicemail_greeting` row id.
	 *
	 * The same idempotence `voicemailMessageLeftData.messageId` buys: a request whose reply was lost
	 * and is retried files ONE greeting rather than two rows racing for the single active slot.
	 */
	greetingId: z.uuid(),
	/** Which slot the recording fills. `*99` records `unavailable`; see the enum. */
	kind: voicemailGreetingKindSchema.default("unavailable"),
	/**
	 * The recorded audio, as a key under the shared object root. See "THE AUDIO IS A KEY" above.
	 *
	 * 1024 matches `voicemailMessageSummarySchema.objectKey` and `recordings.object_key`, which is
	 * the same string in a database column.
	 */
	objectKey: z.string().min(1).max(1_024),
	/**
	 * The media server's own handle for the capture — the file-name stem inside {@link objectKey}.
	 *
	 * Optional and carried for correlation only: it is what joins this request to the
	 * `channel.record.started` / `channel.record.stopped` pair in a support ticket. A responder that
	 * ignores it is correct.
	 */
	recordingId: z.string().min(1).max(128).optional(),
	/**
	 * How long the recording is, as the media server reported it.
	 *
	 * At least one millisecond, and the floor is load bearing rather than tidy: an empty recording
	 * is DISCARDED by the walk before this request is made, because an active greeting containing
	 * silence stops a mailbox announcing itself and says nothing about why. A zero arriving here is
	 * therefore a caller that skipped that rule, and it is refused by the schema rather than filed.
	 */
	durationMs: z.int().min(1),
	/** Present when the greeting came off a live call; for logging correlation only. */
	callId: z.uuid().optional(),
});

export const fileGreetingResponseSchema = z.object({
	/** False means nothing was filed. The handset hears the unavailable announcement. */
	applied: z.boolean(),
	kind: voicemailGreetingKindSchema,
	/**
	 * Whether this greeting is now the ACTIVE one for its kind.
	 *
	 * Separate from `applied` for the reason `enabled` is separate from it on the feature subject: a
	 * greeting that was stored and not activated is a different fact from one that was not stored,
	 * and a runtime that read only `applied` would confirm a recording nobody will ever hear.
	 */
	active: z.boolean().default(false),
	/** Echoed so a reply can be attributed without the caller holding per-request state. */
	greetingId: z.uuid().optional(),
	/** Where the library filed it — `greetings/<org>/<box>/<greetingId>.<ext>`. Diagnostics. */
	objectKey: z.string().max(1_024).optional(),
	/** Why the greeting was refused, for the support ticket. Never played to the handset. */
	reason: z.string().max(256).optional(),
});

export type FileGreetingRequest = z.infer<typeof fileGreetingRequestSchema>;
export type FileGreetingResponse = z.infer<typeof fileGreetingResponseSchema>;

export const FILE_GREETING_RPC = defineRpc(
	RPC_SUBJECTS.pbxFileGreeting,
	fileGreetingRequestSchema,
	fileGreetingResponseSchema,
	// The same five seconds `rpc.pbx.v1.extension-feature` gets, and for its reason plus one more.
	// The responder recompiles the tenant's whole routing artifact inside the write's transaction,
	// because a greeting whose artifact still names the old recording is a greeting that did not
	// happen; and before that it COPIES the audio into the library, which is a minute of PCM at
	// worst, on the volume the media server just wrote it to. A caller listening to a moment of
	// silence before the confirmation is a far better outcome than a confirmation that outran the
	// file.
	5_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.sip.v1.credential — sipd → api, on every REGISTER that answers a digest challenge
// ---------------------------------------------------------------------------------------------

/**
 * The registrar's credential lookup.
 *
 * ## Why the registrar cannot answer this itself
 *
 * `apps/sipd` holds no database handle and must not grow one: extension rows are `pbx-db`, which
 * the API owns. All the registrar has at the moment it must decide is what the phone put on the
 * wire — a realm and a username — so this is the one `rpc.*` request that does **not** carry an
 * `orgId`. Every other subject is called by something that already knows its tenant; here,
 * resolving the tenant IS the request. The responder derives it from the realm and MUST NOT take
 * a tenant hint from the caller, which is why no such field exists to be trusted.
 *
 * ## Why the reply carries HA1 and never a password
 *
 * `ha1 = MD5(username:realm:password)` is exactly what RFC 2617 digest verification consumes, so
 * shipping it lets the registrar answer a REGISTER without ever holding a credential it could
 * replay somewhere else. It also puts the realm inside the hash, which makes a realm change an
 * explicit re-provisioning event rather than a silent authentication outage.
 *
 * The alternative — replying `{ orgId, secretRef }` and letting `apps/sipd` run the derivation —
 * was rejected: it would require `PROVISION_SIP_SECRET_KEY` to be deployed to the SIP edge, which
 * is the most exposed process in the system. The root key derives **every** tenant's password, so
 * a compromised edge would be a total credential compromise rather than the loss of whatever is
 * registered against that edge. Deriving in the API keeps the root key on the control plane, and
 * `apps/sipd/internal/credentials/derive.go` exists to prove the two languages agree on the
 * derivation, not to run it in production.
 *
 * ## `found` and `enabled` are separate, and the SIP layer merges them
 *
 * The registrar answers `403` for both, so a caller cannot tell an unknown extension from a
 * disabled one — no enumeration oracle. They stay distinct on the wire so an operator UI and the
 * logs can say which one actually happened.
 */
export const sipCredentialRequestSchema = z.object({
	/** The digest realm the registrar challenged with. This is what resolves the tenant. */
	realm: z.string().min(1).max(255),
	/** SIP user part, matched case-sensitively per RFC 3261 §19.1.4. */
	username: z.string().min(1).max(128),
	/**
	 * `ip:port` the REGISTER arrived from, and its transport.
	 *
	 * Sent so the responder can apply per-account ACLs and feed the fail2ban-style counters in the
	 * master plan §5 T1 — **not** because the registrar needs them back. A responder that ignores
	 * them is correct today.
	 */
	sourceAddress: z.string().max(64).optional(),
	transport: sipTransportSchema.optional(),
});

export const sipCredentialResponseSchema = z.object({
	/** False means "no such account in this realm". Never means "the lookup failed" — see `reason`. */
	found: z.boolean(),
	/** An account that exists but is administratively off. Distinct on the wire, merged at SIP. */
	enabled: z.boolean().default(false),
	orgId: z.uuid().optional(),
	username: z.string().max(128).optional(),
	realm: z.string().max(255).optional(),
	/** `MD5(username:realm:password)`, lower-case hex. Never a password. */
	ha1: z
		.string()
		.regex(/^[0-9a-f]{32}$/, "ha1 must be 32 lower-case hex characters")
		.optional(),
	deviceId: z.uuid().optional(),
	extensionId: z.uuid().optional(),
	/** Why the lookup could not be answered, for the support ticket. Never shown to a phone. */
	reason: z.string().max(256).optional(),
});

export type SipCredentialRequest = z.infer<typeof sipCredentialRequestSchema>;
export type SipCredentialResponse = z.infer<typeof sipCredentialResponseSchema>;

export const SIP_CREDENTIAL_RPC = defineRpc(
	RPC_SUBJECTS.sipCredential,
	sipCredentialRequestSchema,
	sipCredentialResponseSchema,
	// The tightest deadline in this file, and deliberately so: this one sits inside a REGISTER
	// transaction. A phone's retransmission timer starts at 500 ms, so a reply that arrives later
	// than that is already competing with the retry it caused.
	500,
);

// ---------------------------------------------------------------------------------------------
// rpc.sip.v1.transfer — sipd → engine, on a REFER from a desk phone
// ---------------------------------------------------------------------------------------------

/**
 * Why a SIP transfer was refused.
 *
 * As everywhere else on this backbone, a refusal is a REPLY. Here it is not merely good manners:
 * RFC 3515 obliges the referee to report the outcome back to the phone in a NOTIFY carrying a
 * `message/sipfrag` status line, and a silence would leave `apps/sipd` inventing one. The registrar
 * maps every code below onto a single `SIP/2.0 503 Service Unavailable` frag — the phone gets one
 * honest failure rather than a taxonomy it cannot act on — while the code itself is what the logs
 * and any future operator UI branch on.
 */
export const SIP_TRANSFER_REFUSAL_REASONS = [
	/** Malformed payload, or a required field missing. Retrying the same bytes fails the same way. */
	"bad_request",
	/**
	 * No live call matches the SIP dialog the REFER arrived in.
	 *
	 * The ordinary answer, and the racy one: the transferor hung up, or the far end did, between the
	 * REFER leaving the phone and this request being served.
	 */
	"unknown_dialog",
	/**
	 * The engine cannot map a SIP `Call-ID` onto a channel AT ALL — not "looked and found nothing",
	 * but "there is no index to look in".
	 *
	 * A structurally different answer from {@link unknown_dialog} and worth its own name, because the
	 * two need different fixes: one is a call that ended, the other is a deployment where the media
	 * driver never recorded which SIP dialog produced a channel. `channelCreatedDataSchema.sipCallId`
	 * is optional precisely because the ARI driver does not populate it today; until something does,
	 * every well-formed request is answered with this, and it is a REFUSAL rather than a pretend
	 * success so that a phone's transfer button fails visibly instead of silently doing nothing.
	 */
	"correlation_unavailable",
	/**
	 * The dialog resolved, but to a call in another tenant, or to one the referrer is not a party to.
	 *
	 * The authorisation boundary. `apps/sipd` digest-authenticates the REFER and checks that the
	 * referrer owns a live registration, but it cannot check who is on a call it is not in the path
	 * of. The engine can, and must: without this, any authenticated extension could redirect any
	 * other extension's conversation by guessing a `Call-ID`.
	 */
	"not_permitted",
	/**
	 * The dialog belongs to a call held by ANOTHER engine instance.
	 *
	 * Reserved rather than raised today. The subject is flat and served on a queue group, so exactly
	 * one instance answers and it may not be the one holding the leg; distinguishing that from
	 * `unknown_dialog` needs a dialog directory in KV, the same shape as `park-claims` and
	 * `media-sessions`. Named now so the retry semantics — do not retry here, ask the owner — exist
	 * in the vocabulary before the directory does.
	 */
	"wrong_instance",
	/** The `Refer-To` user part resolves to nothing dialable in this tenant's plan. */
	"unknown_target",
	/**
	 * The REFER carried a `Replaces` header — an ATTENDED transfer completed at the phone — and this
	 * engine cannot honour it.
	 *
	 * Attended transfer exists in `CallControl`, but as a CONSULTATION the engine itself created and
	 * therefore holds the two halves of. A phone that consulted on its own second line and then sent
	 * `Replaces` is asking the engine to join two dialogs it never brokered. Refused by name rather
	 * than downgraded to a blind transfer, which would drop the consultation leg the user is talking
	 * to.
	 */
	"attended_unsupported",
	/** The leg went away between resolution and the transfer. */
	"channel_gone",
	/** The engine tried and the media plane or the dial plan refused. See `error`. */
	"transfer_failed",
	/** This instance is draining. Do not retry HERE. */
	"shutting_down",
	/** Anything else. */
	"internal",
] as const;

export const sipTransferRefusalReasonSchema = z.enum(SIP_TRANSFER_REFUSAL_REASONS);
export type SipTransferRefusalReason = (typeof SIP_TRANSFER_REFUSAL_REASONS)[number];

/** Blind (RFC 5589 §6) versus attended (`Replaces`, RFC 3891). */
export const sipTransferKindSchema = z.enum(["blind", "attended"]);
export type SipTransferKind = z.infer<typeof sipTransferKindSchema>;

/**
 * `rpc.sip.v1.transfer` — the SIP edge asking the call engine to execute a phone's REFER.
 *
 * ## Why this exists at all
 *
 * The engine already transfers calls: `CallControl.transfer` is driven by mid-call DTMF feature
 * codes (`*1`, `*2`). That covers the softphone user who knows the code and nobody else. Every desk
 * phone in the vendor catalogue has a physical TRANSFER key, and pressing it sends a SIP REFER —
 * which reaches the SIP edge, not the engine, because the edge is what the phone has a dialog with.
 * This subject is the seam between the two, and it is the only reason a deskphone's transfer button
 * can work without teaching `apps/sipd` what a dial plan is.
 *
 * ## RAW NATS ON BOTH ENDS
 *
 * The caller is Go (`apps/sipd/internal/transfer`) and the responder is the NestJS engine — the same
 * inversion as `rpc.media.v1.*` with the languages the other way round, and the same obligation. A
 * Nest `@MessagePattern` responder would expect `{"pattern":…,"data":…}` framing that a Go caller
 * does not send, and would simply never answer. The engine serves this on its raw connection
 * (`apps/engine/src/nats/sip-transfer.service.ts`), on the queue group `optimiq-engine-sip-transfer`.
 *
 * ## Why request-reply and not an event
 *
 * RFC 3515 §2.4.4 makes the referee's progress a REQUIRED notification: after the `202 Accepted`,
 * the phone waits for a NOTIFY whose `message/sipfrag` body is the outcome. An event would give
 * `apps/sipd` nothing to put in that body, so it would have to either lie (`200 OK` on publish) or
 * never send one — and a phone that never learns the outcome leaves its transfer indicator lit until
 * the dialog dies. The deadline below is what bounds how long that indicator can stay ambiguous.
 *
 * ## What the edge can and cannot tell you
 *
 * `apps/sipd` is a registrar; it is not in the media path and holds no call state, so every field
 * here is either something the phone put on the wire or something the digest exchange established.
 * In particular it sends the SIP `Call-ID` and the dialog tags VERBATIM and makes no claim that they
 * identify a call the engine knows — resolving that is the engine's half, and `unknown_dialog` /
 * `correlation_unavailable` are the two ways it can fail.
 *
 * ## The referrer is authenticated, the dialog is not
 *
 * `referredBy` is trustworthy: it is the account whose digest response verified against the HA1 the
 * API derived, and the edge refuses a REFER whose `From` is not that account's own AOR. The dialog
 * identity is NOT: a `Call-ID` is a string the phone chose. So the responder must check that the
 * resolved call actually involves `referredBy` before touching it, and answer `not_permitted` when
 * it does not. Trusting the pair would make any authenticated extension able to redirect any other
 * extension's conversation.
 */
export const sipTransferRequestSchema = z.object({
	/** The tenant, from the credential the digest exchange resolved. Re-checked by the responder. */
	orgId: z.uuid(),
	/**
	 * The `Call-ID` of the dialog the REFER arrived in — the call being transferred, not the REFER.
	 *
	 * Opaque and phone-chosen, so it is a LOOKUP KEY and never an authorisation. 256 is RFC 3261's
	 * practical ceiling for the header and matches `channelCreatedDataSchema.sipCallId`.
	 */
	sipCallId: z.string().min(1).max(256),
	/**
	 * The other two thirds of the dialog identifier (RFC 3261 §12), as seen ON THE REFER.
	 *
	 * `fromTag` is therefore the transferor's tag and `toTag` the far end's. Optional because a
	 * responder that can only index `Call-ID` must still be able to serve the common case, and
	 * because a REFER outside a dialog carries no `To` tag at all.
	 */
	fromTag: z.string().max(128).optional(),
	toTag: z.string().max(128).optional(),
	/** The authenticated account that pressed TRANSFER. See the note above on why this is trusted. */
	referredBy: z.object({
		/** `sip:1001@acme.example.com`, host lower-cased — the same spelling the registrar binds. */
		aor: z.string().min(1).max(512),
		/** SIP user part, matched case-sensitively per RFC 3261 §19.1.4. */
		username: z.string().min(1).max(128),
		extensionId: z.uuid().optional(),
		deviceId: z.uuid().optional(),
	}),
	/**
	 * Where the call is going: the `Refer-To` header, taken apart.
	 *
	 * `user` is what the engine dials, because a dial plan takes a destination string and not a URI.
	 * `host` and `uri` come along for the log and for the day a REFER to another domain has to be
	 * refused explicitly rather than silently dialled as a local extension.
	 */
	target: z.object({
		/** The `Refer-To` user part — an extension, a feature code, or an E.164 number. */
		user: dialStringSchema,
		host: z.string().max(255).optional(),
		/** The `Refer-To` URI verbatim, `Replaces` stripped. Diagnostics only. */
		uri: z.string().max(1024).optional(),
	}),
	/** `attended` exactly when {@link replaces} is present; `blind` otherwise. */
	kind: sipTransferKindSchema,
	/**
	 * The `Replaces` parameter of a `Refer-To`, parsed (RFC 3891).
	 *
	 * Present means the phone completed the consultation itself and is asking the engine to join the
	 * dialog it names. Answered `attended_unsupported` today — see that reason.
	 */
	replaces: z
		.object({
			callId: z.string().min(1).max(256),
			toTag: z.string().min(1).max(128),
			fromTag: z.string().min(1).max(128),
			/** The `early-only` flag, which forbids replacing a confirmed dialog. */
			earlyOnly: z.boolean().default(false),
		})
		.optional(),
	/**
	 * The REFER's CSeq number.
	 *
	 * Sent back so a log can be lined up with a packet capture, and because RFC 3515 §2.4.4 keys the
	 * implicit subscription's `Event: refer;id=<cseq>` on exactly this value — the edge needs it to
	 * build the NOTIFY, and echoing it here makes the two halves diagnosable together.
	 */
	referCSeq: z.int().min(0).optional(),
	/**
	 * `ip:port` the REFER arrived from, and its transport. For the responder's audit trail and the
	 * anti-fraud counters; a responder that ignores them is correct.
	 */
	sourceAddress: z.string().max(64).optional(),
	transport: sipTransportSchema.optional(),
});

export const sipTransferResponseSchema = z.object({
	ok: z.boolean(),
	/** Echoed so a reply can be attributed without the requester holding per-request state. */
	sipCallId: z.string().max(256),
	/** The engine instance that answered. Always present, refusal included, for the edge's log. */
	instanceId: z.string().min(1).max(128).optional(),
	/** The leg the transfer was executed on. Present when the dialog resolved, `ok` or not. */
	legId: z.string().min(1).max(128).optional(),
	callId: z.string().min(1).max(128).optional(),
	/** The destination the engine actually dialled, after any plan-side normalisation. */
	destination: z.string().max(128).optional(),
	reason: sipTransferRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type SipTransferRequest = z.infer<typeof sipTransferRequestSchema>;
export type SipTransferResponse = z.infer<typeof sipTransferResponseSchema>;

export const SIP_TRANSFER_RPC = defineRpc(
	RPC_SUBJECTS.sipTransfer,
	sipTransferRequestSchema,
	sipTransferResponseSchema,
	// Two seconds, and the reasoning is neither of the two used elsewhere in this file.
	//
	// It is NOT inside a SIP transaction: the edge answers `202 Accepted` first and reports the
	// outcome later in a NOTIFY, so nothing retransmits while this is in flight and the 500 ms
	// pressure that shapes `rpc.sip.v1.credential` does not apply. What bounds it instead is a human:
	// somebody pressed TRANSFER and is watching their handset for the call to leave. A blind transfer
	// is a dial-plan resolve plus a media move — a couple of ARI round trips — so two seconds is
	// generous for the work and short enough that a sick engine produces a failed transfer the user
	// can retry rather than a phone stuck mid-transfer.
	2_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.media.v1.* — engine → mediad, the media plane's command surface
// ---------------------------------------------------------------------------------------------

/**
 * Why a media command was refused.
 *
 * A refusal is always a REPLY, never a silence. A responder that simply does not answer a request
 * it dislikes is indistinguishable from a crashed one, and the caller pays the whole timeout to
 * learn nothing. The engine branches on this code and never on the human-readable `error`.
 */
export const MEDIA_REFUSAL_REASONS = [
	/** Malformed payload, or a required field missing. Retrying the same bytes fails the same way. */
	"bad_request",
	/** No RTP port pair is free. A LOAD signal: try another instance, or fail with congestion. */
	"capacity",
	/** This instance is draining. Do not retry HERE. */
	"shutting_down",
	/** No such session on this instance. The engine's picture is stale, or it asked the wrong one. */
	"unknown_session",
	/**
	 * The session exists, but on another instance.
	 *
	 * Answerable only because of the `media-sessions` KV directory: without it a second instance
	 * could not tell "never existed" from "belongs to my neighbour", and the two need different
	 * recoveries — give up, versus re-issue against the instance the directory names.
	 */
	"wrong_instance",
	/**
	 * The command is real but this media plane cannot do it yet.
	 *
	 * The honest answer during a per-capability cutover: `mediad` climbs the ladder in
	 * `plans/mediad-design.md` §2 one rung at a time, and a rung it has not reached must fail
	 * LOUDLY. A media server that quietly did nothing would produce a call that connects and has no
	 * audio, which is the single hardest telephony defect to trace back to its cause.
	 */
	"not_supported",
	/** Anything else. */
	"internal",
] as const;

export const mediaRefusalReasonSchema = z.enum(MEDIA_REFUSAL_REASONS);
export type MediaRefusalReason = (typeof MEDIA_REFUSAL_REASONS)[number];

/** The G.711 payload types `mediad` handles. v1 is passthrough — see `plans/mediad-design.md` §7. */
export const mediaCodecSchema = z.enum(["PCMU", "PCMA"]);
export type MediaCodec = z.infer<typeof mediaCodecSchema>;

/**
 * An SDP body, as bytes the signalling plane handed over.
 *
 * A string and not a parsed structure, deliberately. `apps/sipd` treats SDP as opaque and never
 * picks a codec; `apps/engine` is the courier; `mediad` is the only process that knows which ports
 * are free and which payload types it can really handle, so it is the only one that parses. A
 * structured field here would be a second opinion about mediad's own capabilities, held by two
 * services that cannot check it.
 *
 * 16 KiB is far above any real offer (a verbose WebRTC one is ~4 KiB) and far below a size a
 * malicious sender could use to make a broker do work.
 */
const sdpSchema = z.string().min(1).max(16_384);

/** Fields every media command carries so a refusal can be attributed without a lookup. */
const mediaCommandShape = {
	/** Caller-assigned session id. See {@link mediaAllocateSessionRequestSchema}. */
	sessionId: z.string().min(1).max(128),
};

/**
 * `rpc.media.v1.allocate-session` — reserve an RTP port pair and answer an SDP offer.
 *
 * ## RAW NATS ON BOTH ENDS. This is not a style preference.
 *
 * Every prior `rpc.*` subject had a TypeScript responder, and two of them a Go caller. This family
 * inverts it: the responder is Go (`apps/mediad/internal/control`) and the caller is the NestJS
 * engine. The obligation inverts with it.
 *
 * A NestJS `ClientProxy.send()` does not put this payload on the wire. It wraps it:
 *
 * ```text
 * request   {"pattern":"rpc.media.v1.allocate-session","data":{…this schema…},"id":"…"}
 * reply     {"response":{…this schema…},"isDisposed":true,"id":"…"}
 * ```
 *
 * `mediad` unmarshals the bare contract and would see a request with no `sessionId`, refuse it as
 * `bad_request`, and reply in a frame the `ClientProxy` would not recognise either. So the engine's
 * client MUST issue a raw `NatsConnection.request()` — the engine already holds a raw connection
 * (`apps/engine/src/nats/jetstream.service.ts`), so this costs nothing but has to be written down,
 * because `ClientProxy` is the idiomatic Nest thing to reach for and it is wrong here.
 *
 * ## Why `sessionId` is assigned by the CALLER
 *
 * Same reason `OriginateRequest.channelId` is client-assigned at the engine's `MediaPort` seam: the
 * caller must be able to release a session whose allocate reply it never received. A
 * server-assigned id means a timed-out allocate leaves a port held under a name nobody knows, and
 * the only recovery is the idle reaper minutes later. It is also what makes allocate IDEMPOTENT —
 * a retry returns the same session rather than opening a second port.
 *
 * ## Why the offer is required
 *
 * v1 ANSWERS offers. Generating an offer for a leg the engine is originating (where no offer exists
 * yet) is a different negotiation and arrives with the rung that needs it; leaving `sdpOffer`
 * optional would let a caller ask for something no code path serves and get a reply that looked
 * successful.
 */
export const mediaAllocateSessionRequestSchema = z.object({
	...mediaCommandShape,
	/**
	 * The tenant. Carried so `mediad` can publish its lifecycle events on an org-scoped subject —
	 * `media.evt.v1.<orgId>.<sessionId>.<event>` — without holding a database handle or a directory
	 * lookup it would have to keep fresh.
	 */
	orgId: z.uuid(),
	/** The call this leg belongs to. Lands on the lifecycle events and in the session directory. */
	callId: z.string().min(1).max(128),
	/** The engine's leg id, when it differs from the session id. Logging and correlation only. */
	legId: z.string().min(1).max(128).optional(),
	/** The far end's offer, verbatim. See {@link sdpSchema}. */
	sdpOffer: sdpSchema,
	/**
	 * The direction to answer with.
	 *
	 * `sendrecv` for a normal leg, `inactive` for one that is ringing but not yet answered. Held
	 * legs (`sendonly`/`recvonly`) are rung 5; asking for one today is answered `not_supported`
	 * rather than silently downgraded to `sendrecv`, because a downgrade would put a held caller
	 * back into the conversation.
	 */
	direction: z.enum(["sendrecv", "sendonly", "recvonly", "inactive"]).default("sendrecv"),
});

export const mediaAllocateSessionResponseSchema = z.object({
	ok: z.boolean(),
	sessionId: z.string().min(1).max(128),
	/** The answer to put back into the SIP dialog. Present exactly when `ok`. */
	sdpAnswer: sdpSchema.optional(),
	/**
	 * The `mediad` process holding the session, and the value written to the `media-sessions` KV
	 * directory. The engine keeps it so a later command can be attributed when it is refused.
	 */
	instanceId: z.string().min(1).max(128).optional(),
	/** Where the far end should send RTP — `MEDIAD_PUBLIC_IP`, never the bind address. */
	address: z.string().max(64).optional(),
	rtpPort: z.int().min(1).max(65_534).optional(),
	/** Always `rtpPort + 1` (RFC 3550 §11). Stated so a caller never re-derives a convention. */
	rtcpPort: z.int().min(1).max(65_535).optional(),
	ssrc: z.int().min(0).max(4_294_967_295).optional(),
	/** The codec the answer settled on. One of them, not a list: the answer is a choice. */
	codec: mediaCodecSchema.optional(),
	/** The negotiated RFC 4733 telephone-event payload type, when the offer carried one. */
	telephoneEventPayloadType: z.int().min(0).max(127).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaAllocateSessionRequest = z.infer<typeof mediaAllocateSessionRequestSchema>;
export type MediaAllocateSessionResponse = z.infer<typeof mediaAllocateSessionResponseSchema>;

export const MEDIA_ALLOCATE_SESSION_RPC = defineRpc(
	RPC_SUBJECTS.mediaAllocateSession,
	mediaAllocateSessionRequestSchema,
	mediaAllocateSessionResponseSchema,
	// An allocate binds two sockets and parses an offer — microseconds of work. It also sits inside
	// the engine's answer of an INVITE, where the caller hears every millisecond as silence before
	// ringback. 500 ms is three orders of magnitude of headroom, and a reply slower than that means
	// the instance is sick rather than busy.
	500,
);

/**
 * `rpc.media.v1.bridge-sessions` — put two or more allocated sessions in one conversation.
 *
 * ## Two is a relay, three is a room, and the caller does not have to know which
 *
 * This schema said `.length(2)` for four rungs, and the JSDoc above it promised that the limit
 * would lift when rung 6 arrived: "N-way is mixing, which needs a decode, a jitter buffer and a
 * mix-minus per participant, and a three-element array here would be a contract promising something
 * the media plane cannot do." Rung 6 arrived — `apps/mediad/internal/rtp/conference.go` is the
 * mixer, and `tap-session` has been converting two-party bridges into rooms since it landed — so
 * the promise is kept here rather than by growing a second subject.
 *
 * Which mechanism serves a request is the responder's business and deliberately not the caller's:
 * two sessions become a RELAY (each forwards its payload to the other; no decode, no buffer, no
 * added delay) and three or more become a ROOM (a jitter buffer, a decode and a mix-minus per
 * member). An engine asking for a conference bridge writes the same command it writes for a
 * two-party call, and the sixty milliseconds of playout delay a mix costs are a property of the
 * arrangement rather than of the request.
 *
 * ## Why the ceiling is eight rather than unbounded
 *
 * The mixer sums every member's decoded audio once per member per frame, fifty times a second, so
 * the cost is quadratic in the room and the number where that stops being free is a capacity
 * decision one process gets to make. Eight is where this platform's mixer is measured, it is above
 * every room a small business actually holds, and — the reason it is a SCHEMA bound and not a
 * runtime one — a caller that asks for nine gets a validation error naming the field instead of a
 * refusal three hops later with half a room already mixing.
 *
 * A larger room is a real feature and it is not this: it needs a mixer that maintains one sum and
 * subtracts each member from it, which is a different algorithm rather than a bigger constant.
 * Raising this number without writing that is how a conference of thirty makes every other call on
 * the instance stutter.
 *
 * `bridgeId` is caller-assigned for the same reason `sessionId` is, and because the engine's
 * `MediaPort` already mints one in `createBridge` before any leg joins. A room keeps the BRIDGE's
 * id — the engine tears down what it created, under the name it created it with.
 */
export const MEDIA_BRIDGE_MAX_SESSIONS = 8;

export const mediaBridgeSessionsRequestSchema = z.object({
	bridgeId: z.string().min(1).max(128),
	/**
	 * The sessions to put in one conversation. Order is not significant — a relay is bidirectional
	 * and a mix is symmetric — with one exception the caller should know about: on a request that
	 * CONVERTS an existing two-party call into a room, the media plane resolves the `a`/`b` letters
	 * of {@link mediaTapSessionRequestSchema} from join order unless a `targetSide` says otherwise.
	 */
	sessionIds: z.array(z.string().min(1).max(128)).min(2).max(MEDIA_BRIDGE_MAX_SESSIONS),
});

export const mediaBridgeSessionsResponseSchema = z.object({
	ok: z.boolean(),
	bridgeId: z.string().min(1).max(128),
	/** The sessions actually in the conversation. Empty on a refusal. */
	sessionIds: z.array(z.string().max(128)).max(MEDIA_BRIDGE_MAX_SESSIONS).default([]),
	/**
	 * Whether this arrangement is a MIX rather than a relay — three or more members, or two that
	 * were already in a room.
	 *
	 * On the reply because it is the one fact an operator needs to explain "the call developed
	 * sixty milliseconds of delay the moment the third person joined", and because it is not
	 * derivable from `sessionIds.length` alone: a two-party call that a tap converted stays mixed.
	 */
	mixed: z.boolean().default(false),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaBridgeSessionsRequest = z.infer<typeof mediaBridgeSessionsRequestSchema>;
export type MediaBridgeSessionsResponse = z.infer<typeof mediaBridgeSessionsResponseSchema>;

export const MEDIA_BRIDGE_SESSIONS_RPC = defineRpc(
	RPC_SUBJECTS.mediaBridgeSessions,
	mediaBridgeSessionsRequestSchema,
	mediaBridgeSessionsResponseSchema,
	500,
);

/**
 * `rpc.media.v1.unbridge-sessions` — stop the relay, leave both sessions alive.
 *
 * Separating legs is NOT hanging them up: an attended transfer takes a leg out of one bridge and
 * puts it in another, and a media plane that tore the session down in between would drop the call
 * it was in the middle of moving.
 *
 * Idempotent: unbridging a bridge that is already gone answers `ok: true, unbridged: false`. The
 * engine retries an unbridge, and a retry after a lost reply must not look like a failure.
 */
export const mediaUnbridgeSessionsRequestSchema = z.object({
	bridgeId: z.string().min(1).max(128),
});

export const mediaUnbridgeSessionsResponseSchema = z.object({
	ok: z.boolean(),
	bridgeId: z.string().min(1).max(128),
	/** False when there was no such relay. A SUCCESS, not a failure — see the note above. */
	unbridged: z.boolean().default(false),
	/**
	 * Everybody who was in the conversation. Bounded by
	 * {@link MEDIA_BRIDGE_MAX_SESSIONS} rather than by two, because since rung 6 a `bridgeId` may
	 * name a ROOM: tearing one down returns every member, and a cap of two would have truncated the
	 * list of legs the engine still has to account for.
	 */
	sessionIds: z.array(z.string().max(128)).max(MEDIA_BRIDGE_MAX_SESSIONS).default([]),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaUnbridgeSessionsRequest = z.infer<typeof mediaUnbridgeSessionsRequestSchema>;
export type MediaUnbridgeSessionsResponse = z.infer<typeof mediaUnbridgeSessionsResponseSchema>;

export const MEDIA_UNBRIDGE_SESSIONS_RPC = defineRpc(
	RPC_SUBJECTS.mediaUnbridgeSessions,
	mediaUnbridgeSessionsRequestSchema,
	mediaUnbridgeSessionsResponseSchema,
	500,
);

/**
 * `rpc.media.v1.release-session` — free the port pair and forget the session.
 *
 * Also removes the session's entry from the `media-sessions` KV directory. That cleanup is part of
 * the contract rather than an implementation detail: a directory entry that outlives its session is
 * an instance name the engine will keep routing commands to, and every one of them answers
 * `unknown_session` until an operator notices.
 */
export const mediaReleaseSessionRequestSchema = z.object({
	...mediaCommandShape,
});

export const mediaReleaseSessionResponseSchema = z.object({
	ok: z.boolean(),
	sessionId: z.string().min(1).max(128),
	/** False when there was no such session. Idempotent, exactly like `unbridged` above. */
	released: z.boolean().default(false),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaReleaseSessionRequest = z.infer<typeof mediaReleaseSessionRequestSchema>;
export type MediaReleaseSessionResponse = z.infer<typeof mediaReleaseSessionResponseSchema>;

export const MEDIA_RELEASE_SESSION_RPC = defineRpc(
	RPC_SUBJECTS.mediaReleaseSession,
	mediaReleaseSessionRequestSchema,
	mediaReleaseSessionResponseSchema,
	500,
);

/**
 * `rpc.media.v1.start-playback` — play audio from a file towards the session's far end.
 *
 * Rung 1's second half (`plans/mediad-design.md` §2): a session sourcing frames from a file instead
 * of from a socket. It is the command behind the engine's `play` verb, and therefore behind every
 * IVR prompt, every voicemail greeting and the "press 1 to accept" of a confirmed transfer.
 *
 * ## Why `media` is an array of media-server URIs
 *
 * Because {@link https://github.com/optimiqs/optimiq-voice/blob/main/apps/engine/src/media/media-port.ts | `PlayRequest.media`}
 * already is: ARI plays a list in sequence and the engine's seam inherited that. `mediad`
 * concatenates the clips into one frame stream, which is the same user-visible behaviour with none
 * of the state a queue would need.
 *
 * The only scheme `mediad` resolves is `sound:`, which is exactly what
 * `apps/engine/src/routing/media-refs.ts` renders every domain `MediaRef` into. Asterisk's
 * GENERATOR schemes — `tone:`, `digits:`, `number:`, `characters:` — are refused `not_supported` by
 * name rather than skipped: a media plane that silently dropped one element of a prompt list would
 * play half a sentence, which is worse than the engine routing the leg to Asterisk.
 *
 * ## Why the reply comes back when playback has STARTED, not when it has finished
 *
 * `MediaPort.play` returns a handle the moment audio begins — the verb executor says so in as many
 * words, and barge-in depends on it: a caller who presses a digit must be able to interrupt without
 * the engine holding a fiber open for the length of the prompt. So this is a 500 ms command like
 * every other one in the family, and the END of the playback is a JetStream event
 * (`media.evt.v1.<orgId>.<sessionId>.playback.finished`), not a slow reply.
 *
 * ## Why `playbackRef` is caller-assigned
 *
 * The same reason `sessionId` is, plus one more: {@link mediaStopPlaybackRequestSchema} carries
 * NOTHING ELSE, so the reference has to be a name the engine already knows.
 */
export const mediaStartPlaybackRequestSchema = z.object({
	...mediaCommandShape,
	/** Caller-assigned handle. `stop-playback` names it, and so does `playback.finished`. */
	playbackRef: z.string().min(1).max(128),
	/**
	 * Media URIs, played in sequence. At least one — a play of nothing is a caller bug, and
	 * answering `ok` to it would report a prompt that never happened.
	 */
	media: z.array(z.string().min(1).max(512)).min(1).max(16),
	/**
	 * The language the prompt should be served in, when the caller has an opinion.
	 *
	 * Accepted and currently IGNORED by `mediad`, which resolves a path and reads a file. It is on
	 * the contract because `PlayRequest.language` is on the seam above it and dropping a field at
	 * the adapter would make the two drivers silently disagree about what was asked for; a prompt
	 * library with per-language variants is the wave that gives it meaning.
	 */
	language: z.string().min(1).max(32).optional(),
});

export const mediaStartPlaybackResponseSchema = z.object({
	ok: z.boolean(),
	sessionId: z.string().min(1).max(128),
	playbackRef: z.string().min(1).max(128),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaStartPlaybackRequest = z.infer<typeof mediaStartPlaybackRequestSchema>;
export type MediaStartPlaybackResponse = z.infer<typeof mediaStartPlaybackResponseSchema>;

export const MEDIA_START_PLAYBACK_RPC = defineRpc(
	RPC_SUBJECTS.mediaStartPlayback,
	mediaStartPlaybackRequestSchema,
	mediaStartPlaybackResponseSchema,
	// Longer than the other four, and for a reason that is visible in the handler: this one READS A
	// FILE off disk and encodes it before it answers, where the rest bind a socket or move a pointer.
	// Still on a call path — the caller is listening to silence until the prompt starts — so it is
	// bounded well inside the second at which a person assumes the menu is broken.
	1_000,
);

/**
 * `rpc.media.v1.stop-playback` — interrupt a playback started by
 * {@link mediaStartPlaybackRequestSchema}.
 *
 * ## Why there is no `sessionId`
 *
 * Because `MediaPort.stopPlayback(playbackRef)` has none. Barge-in is the caller of this command —
 * the `gather` verb stops its prompt the moment collection ends, whatever ended it — and it holds a
 * reference and nothing else. Threading a session id onto the seam purely so this payload could
 * carry one would be shaping the engine's interface around a lookup `mediad` can do for itself.
 *
 * ## Idempotent, and a stop of a finished playback is a SUCCESS
 *
 * `ok: true, stopped: false`, exactly like `unbridged` and `released` above it. `MediaPort` states
 * the rule directly — "stopping an already-finished playback is a no-op" — and it is the common
 * case rather than an edge one: a caller who lets the menu play to the end and then presses a digit
 * produces exactly this, on every single call.
 */
export const mediaStopPlaybackRequestSchema = z.object({
	playbackRef: z.string().min(1).max(128),
});

export const mediaStopPlaybackResponseSchema = z.object({
	ok: z.boolean(),
	playbackRef: z.string().min(1).max(128),
	/** False when there was nothing playing. A SUCCESS, not a failure — see the note above. */
	stopped: z.boolean().default(false),
	/** The session the playback was on, when there was one. Logging and correlation only. */
	sessionId: z.string().min(1).max(128).optional(),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaStopPlaybackRequest = z.infer<typeof mediaStopPlaybackRequestSchema>;
export type MediaStopPlaybackResponse = z.infer<typeof mediaStopPlaybackResponseSchema>;

export const MEDIA_STOP_PLAYBACK_RPC = defineRpc(
	RPC_SUBJECTS.mediaStopPlayback,
	mediaStopPlaybackRequestSchema,
	mediaStopPlaybackResponseSchema,
	500,
);

/**
 * `rpc.media.v1.send-dtmf` — generate RFC 4733 digits towards a leg's far end. Rung 3.
 *
 * ## Why this is generation and not the DTMF that already works
 *
 * Digits pressed by a party ALREADY cross a `mediad` bridge, and have since rung 2: a
 * telephone-event payload is just bytes to a relay, so the header rewrite forwards them and
 * renumbers the payload type between two legs that negotiated differently. What that path cannot do
 * is ORIGINATE a digit — an attended transfer punching an extension into a far-end IVR, or a
 * confirmed-transfer "press 1 to accept" answered on the caller's behalf — because there is no
 * inbound packet to forward. This command is the leg that has to be synthesised.
 *
 * ## Refused when the leg negotiated no telephone-event payload type
 *
 * `not_supported`, by name, and NOT silently rendered as an inband tone. A leg whose SDP answer
 * carried no RFC 4733 type has told us it does not expect one, and the two alternatives are both
 * worse than a refusal: sending under a type the far end never agreed to produces digits it drops
 * (an IVR that "randomly" ignores keypresses), and synthesising an audible tone into the G.711
 * stream means writing a tone generator, which is the same deferral `tone://` carries at
 * `start-playback`. The engine answers a refusal by routing the leg to Asterisk, which has both.
 *
 * ## Why the reply comes back when injection has STARTED
 *
 * Exactly what ARI's `POST /channels/{id}/dtmf` does — Asterisk queues the frames and answers — so
 * mirroring it is what keeps the two drivers behaving identically at the seam above, which is the
 * property the whole cutover rests on. Everything that could be REFUSED (no such session, no
 * negotiated type, an unsendable digit, a far end that has not been learned yet) is decided before
 * the first packet, so an `ok` reply means the digits are going out rather than that they were
 * accepted for consideration. `queuedMs` is how long the far end will be receiving them, which is
 * the one fact the caller cannot compute without knowing this service's defaults.
 */
export const mediaSendDtmfRequestSchema = z.object({
	...mediaCommandShape,
	/**
	 * The digits to generate: `0-9`, `*`, `#`, and `A-D`.
	 *
	 * 32 is a deliberate cap rather than a round number: the longest thing anybody legitimately
	 * punches into a far-end IVR is an account or conference PIN, and a string long enough to hold
	 * a media session busy for a minute is a caller bug this refuses in one round trip.
	 */
	digits: z
		.string()
		.min(1)
		.max(32)
		.regex(/^[0-9A-Da-d*#]+$/, "digits may only contain 0-9, A-D, * and #"),
	/**
	 * How long each tone lasts. Milliseconds, as everywhere above this seam.
	 *
	 * The floor is 40 ms because RFC 4733 receivers and every inband detector built for one need
	 * enough of a tone to recognise it, and a 20 ms digit is one packet that a single loss erases.
	 */
	toneDurationMs: z.int().min(40).max(1_000).optional(),
	/** Silence between digits. Zero is legal and means "back to back". */
	gapMs: z.int().min(0).max(1_000).optional(),
});

export const mediaSendDtmfResponseSchema = z.object({
	ok: z.boolean(),
	sessionId: z.string().min(1).max(128),
	/** The digits accepted, echoed so a log line carries them without the request beside it. */
	digits: z.string().max(32).default(""),
	/**
	 * How long the whole string will take to put on the wire, tone and gap included.
	 *
	 * The reply is sent when injection STARTS, so this is the only number that tells a caller when
	 * the far end will have heard the last digit.
	 */
	queuedMs: z.int().min(0).optional(),
	/** The RFC 4733 payload type the digits are being sent under. The leg's own negotiated one. */
	telephoneEventPayloadType: z.int().min(0).max(127).optional(),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaSendDtmfRequest = z.infer<typeof mediaSendDtmfRequestSchema>;
export type MediaSendDtmfResponse = z.infer<typeof mediaSendDtmfResponseSchema>;

export const MEDIA_SEND_DTMF_RPC = defineRpc(
	RPC_SUBJECTS.mediaSendDtmf,
	mediaSendDtmfRequestSchema,
	mediaSendDtmfResponseSchema,
	// 500 ms like the rest of the family, and it fits for the same reason: this command validates,
	// takes a lock and starts a goroutine. The DIGITS take seconds; answering only once they were
	// all on the wire would put a multi-second command on a call path for no information the caller
	// does not already have from `queuedMs`.
	500,
);

/**
 * How a `mediad` recording captures a session. Rung 4.
 *
 * ## Why this field exists at all, and why `MediaPort` has no equivalent
 *
 * On Asterisk the choice is made by WHICH CHANNEL is recorded rather than by an argument:
 * `apps/engine/src/routing/plan-walker.ts` records the caller's own channel for voicemail and gets
 * one direction, and `apps/engine/src/calls/call-control.ts` first creates a snoop channel spying
 * on `both` and records THAT to get the conversation. `RecordRequest` therefore has no direction on
 * it — the direction was encoded in the channel id.
 *
 * `mediad` has no snoop channel and needs none: a session is already both directions, so the choice
 * is an argument here. That is the whole reason `MediaPort.snoop` stays refused on this driver — it
 * is an Asterisk-ism that exists to give a tap something to be addressed as, and reproducing it
 * would mean inventing a session with no port that publishes a `leg-arrived` for a leg that does
 * not exist.
 */
export const MEDIA_RECORDING_DIRECTIONS = [
	/**
	 * What the session RECEIVES: the far party speaking, and nothing this leg was sent.
	 *
	 * The faithful mirror of ARI's `channels.record` on a plain channel, which is what the
	 * voicemail path uses — a mailbox message should contain the caller, not the greeting that was
	 * played at them.
	 */
	"receive",
	/**
	 * Both directions, summed into one mono stream.
	 *
	 * The snoop replacement, and what an on-demand call recording means. It is a real mix (decode
	 * both G.711 streams, add the linear samples, re-encode once at the end) rather than the
	 * passthrough the relay does, and it is affordable HERE for the reason it is not affordable on
	 * the call path: nothing downstream is waiting on it, a recording is written at wall-clock pace
	 * by one goroutine, and a frame of skew between the two directions is inaudible in a playback
	 * where it would be a defect in a live conference. Rung 6's mixer is a different problem.
	 */
	"both",
] as const;

export const mediaRecordingDirectionSchema = z.enum(MEDIA_RECORDING_DIRECTIONS);
export type MediaRecordingDirection = (typeof MEDIA_RECORDING_DIRECTIONS)[number];

/**
 * `rpc.media.v1.start-recording` — write a session's audio to a file. Rung 4.
 *
 * ## Where the file goes, and why the engine does not say
 *
 * `MEDIAD_RECORDINGS_DIR/<orgId>/<callId>/<recordingRef>.wav`, and every one of those tokens is
 * something `mediad` already holds: the org and the call came in on `allocate-session` and live on
 * the session, the reference is on this request. That is not a coincidence — it is exactly the
 * object key `apps/engine` computes for the same recording
 * (`${organizationId}/${callId}/${recordingId}.${format}`) and exactly what `apps/api`'s archiver
 * stats under `CDR_RECORDING_ROOT`, so one mount serves both planes and the archive pipeline needs
 * no change to read what `mediad` wrote. It is the same mount discipline `MEDIAD_SOUNDS_DIR` uses
 * for prompts, and for the same reason: putting an object-store fetch on the media plane would give
 * the process with RTP sockets open to the internet a control-plane credential.
 *
 * A path is NOT accepted from the caller. The engine naming a directory would let a malformed or
 * hostile request write anywhere the process can, and the engine has nothing to say about the
 * layout that `mediad` cannot derive.
 *
 * ## What is refused rather than approximated
 *
 * - `beep` — `mediad` has no tone generator (the same deferral `tone://` carries at
 *   `start-playback`). A voicemail whose beep never sounds is a caller talking over the tail of the
 *   greeting, so it is refused rather than dropped.
 * - `terminateOn` — ending a recording on a digit needs DTMF DETECTION, which is the receive half
 *   of rung 3 and not built: `mediad` relays telephone-event payloads without decoding them. A
 *   recording that ignored `#` would run to `maxDurationMs` on every voicemail.
 *
 * Both are `not_supported` with the capability named, which the engine answers by routing that leg
 * to Asterisk. Accepting them and doing nothing is the failure mode this whole vocabulary exists to
 * prevent.
 */
export const mediaStartRecordingRequestSchema = z.object({
	...mediaCommandShape,
	/**
	 * Caller-assigned handle. `stop-recording` names it, `recording.finished` carries it, and it is
	 * the FILENAME stem — so it is also what joins the file on disk to the engine's object key.
	 */
	recordingRef: z.string().min(1).max(128),
	/** Which side of the session to capture. See {@link MEDIA_RECORDING_DIRECTIONS}. */
	direction: mediaRecordingDirectionSchema.default("both"),
	/**
	 * Container. `wav` is the only one `mediad` writes, and anything else is `not_supported` by
	 * name: `apps/api` serves recordings as `audio/wav` and the archiver copies bytes it never
	 * inspects, so a `gsm` file under a `.gsm` key would download and fail to play.
	 */
	format: z.enum(["wav"]).default("wav"),
	/** Hard stop. Milliseconds — the seam above speaks seconds because ARI does; this does not. */
	maxDurationMs: z
		.int()
		.min(1_000)
		.max(4 * 60 * 60 * 1_000)
		.optional(),
	/** Stop after this much continuous silence. Absent means "record until told to stop". */
	maxSilenceMs: z
		.int()
		.min(500)
		.max(60 * 60 * 1_000)
		.optional(),
	/** Refused when true — see the note above. Carried so the two drivers cannot silently differ. */
	beep: z.boolean().optional(),
	/** Digits that end the recording. `none` and the empty string mean the same thing: no digits. */
	terminateOn: z.string().max(16).optional(),
});

export const mediaStartRecordingResponseSchema = z.object({
	ok: z.boolean(),
	sessionId: z.string().min(1).max(128),
	recordingRef: z.string().min(1).max(128),
	/**
	 * The object key the file will land under, RELATIVE to the recordings root —
	 * `<orgId>/<callId>/<recordingRef>.wav`.
	 *
	 * Relative and not absolute on purpose: the absolute path differs per container (the API mounts
	 * the same directory at a different place from the media plane), so an absolute one would be
	 * true for `mediad` and wrong for everybody reading the reply. This is the value that joins to
	 * `recordings.object_key`.
	 */
	objectKey: z.string().min(1).max(1_024).optional(),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaStartRecordingRequest = z.infer<typeof mediaStartRecordingRequestSchema>;
export type MediaStartRecordingResponse = z.infer<typeof mediaStartRecordingResponseSchema>;

export const MEDIA_START_RECORDING_RPC = defineRpc(
	RPC_SUBJECTS.mediaStartRecording,
	mediaStartRecordingRequestSchema,
	mediaStartRecordingResponseSchema,
	// 1 s, matching `start-playback` and for the mirror-image reason: that one READS a file before
	// it answers, this one CREATES one — a directory tree to make, a file to open and a header to
	// write — and a reply that arrives before the file exists would let the first frame be dropped
	// on the floor. Everything after the header is the recorder's own goroutine.
	1_000,
);

/**
 * `rpc.media.v1.stop-recording` — close the file and publish `recording.finished`.
 *
 * ## Why there is no `sessionId`
 *
 * Because `MediaPort.stopRecording(name)` has none, exactly as with `stop-playback`. The engine
 * stops a recording from a handler holding a reference, so `mediad` indexes live recordings by
 * reference and does the lookup itself rather than having a session id threaded onto the seam above
 * purely to make this payload look symmetrical.
 *
 * ## Idempotent, and a stop of a finished recording is a SUCCESS
 *
 * `ok: true, stopped: false`. `MediaPort` states the rule — "already-finished is a no-op" — and it
 * is the normal case rather than an edge one: a recording that hit `maxDurationMs`, or whose leg
 * hung up, has already finalised itself by the time the engine's teardown gets around to stopping
 * it.
 *
 * ## The reply is not the finalisation
 *
 * It says the recorder was told to stop. `recording.finished` says the header has been patched, the
 * bytes fsynced and the file renamed into place, and THAT is the event the archive pipeline must
 * wait for — an archive triggered on this reply would copy a file that is still being written.
 */
export const mediaStopRecordingRequestSchema = z.object({
	recordingRef: z.string().min(1).max(128),
});

export const mediaStopRecordingResponseSchema = z.object({
	ok: z.boolean(),
	recordingRef: z.string().min(1).max(128),
	/** False when there was nothing recording. A SUCCESS, not a failure — see the note above. */
	stopped: z.boolean().default(false),
	/** The session the recording was on, when there was one. Logging and correlation only. */
	sessionId: z.string().min(1).max(128).optional(),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaStopRecordingRequest = z.infer<typeof mediaStopRecordingRequestSchema>;
export type MediaStopRecordingResponse = z.infer<typeof mediaStopRecordingResponseSchema>;

export const MEDIA_STOP_RECORDING_RPC = defineRpc(
	RPC_SUBJECTS.mediaStopRecording,
	mediaStopRecordingRequestSchema,
	mediaStopRecordingResponseSchema,
	500,
);

// ---------------------------------------------------------------------------------------------
// rpc.media.v1.tap-session — engine → mediad, supervision (eavesdrop / whisper / barge)
// ---------------------------------------------------------------------------------------------

/**
 * Which side of a two-party call a tap is talking about.
 *
 * `a` and `b` are the same leg roles `packages/telephony`'s `LEG_ROLES` names — the originating
 * side and the side originated for it — so a supervisor coaching "the agent" says `speakTo: "b"`
 * on an inbound customer call and the media plane needs no idea what an agent is. `both` and
 * `none` complete the lattice, and `none` is only ever meaningful on `speakTo`: a tap that heard
 * nothing would be a session allocated for no reason.
 */
export const MEDIA_TAP_SIDES = ["a", "b", "both", "none"] as const;
export const mediaTapSideSchema = z.enum(MEDIA_TAP_SIDES);
export type MediaTapSide = (typeof MEDIA_TAP_SIDES)[number];

/**
 * `rpc.media.v1.tap-session` — join a session's conversation on ASYMMETRIC terms.
 *
 * ## This is deliberately not a snoop, and the difference is the whole contract
 *
 * `plans/mediad-design.md` §10 question 4 settles it: `MediaPort.snoop` is refused by this media
 * plane permanently, because a snoop channel exists only to give ARI something to address — a tap
 * has to BE a channel there, so it is one. Reproducing that here would mean a session with no port
 * publishing a `leg-arrived` for a leg that does not exist, which is precisely the "emit synthetic
 * ARI events forever" outcome §3.2 exists to prevent.
 *
 * So supervision is specified as what it actually is: a THIRD PARTICIPANT in a bridge whose
 * contribution is routed differently per peer. `hear` says which peers' audio reaches the
 * supervisor; `speakTo` says which peers the supervisor's audio reaches. The three industry
 * features fall out as three points, and there is no branch anywhere for which one it is:
 *
 * ```text
 * eavesdrop   hear: "both"   speakTo: "none"
 * whisper     hear: "both"   speakTo: "b"      (or "a" — whichever leg is the coached one)
 * barge       hear: "both"   speakTo: "both"
 * ```
 *
 * ## Why the full shape ships before the implementation does
 *
 * `mediad` refuses this today: v1 relays RTP without decoding it, and routing one participant's
 * audio to one peer and not the other is a MIX, which is rung 6. Declaring the whole shape now is
 * the point rather than an oversight — a tap IS a mix-minus participant (`speakTo: "none"` is a
 * participant subtracted from everybody's mix; `speakTo: "a"` is one that appears in exactly one
 * peer's), so the rung-6 mixer serves this contract by ARRIVING. Had `*0` been built against
 * `snoop` instead, the cutover would have had to either invent a channel concept this plane does
 * not have or break a shipped feature's wire format.
 *
 * ## Ids and lifecycle
 *
 * `tapSessionId` is the supervisor's OWN allocated session — the tap is a participant, so it has a
 * port and an SDP like any other leg, and it was allocated by `allocate-session` before this call.
 * `targetSessionId` is any session in the conversation being joined; the media plane resolves the
 * bridge from it, which is why the caller does not have to know a bridge id it may never have seen
 * (on this driver a bridge only exists once two members are in it).
 *
 * `tapId` is caller-assigned for the same reason `bridgeId` and `sessionId` are: the engine must be
 * able to untap something whose reply it never received.
 */
export const mediaTapSessionRequestSchema = z.object({
	/** Caller-assigned handle for the tap itself. See above. */
	tapId: z.string().min(1).max(128),
	/** The supervisor's own allocated session — a real participant with a real port. */
	tapSessionId: z.string().min(1).max(128),
	/** Any session in the conversation being joined; the bridge is resolved from it. */
	targetSessionId: z.string().min(1).max(128),
	/**
	 * Which side of the conversation {@link targetSessionId} IS — `a` or `b`.
	 *
	 * ## The convention this replaces, and why it needed replacing
	 *
	 * `hear` and `speakTo` name a SIDE of a two-party call, so serving them requires knowing which
	 * side each session is on. Until this field existed the media plane fixed the only convention it
	 * could defend from the ids in the request — **`a` is the target session and `b` is the other
	 * party** — and enforced it by joining the two legs to the room in TARGET-FIRST order when it
	 * converted a relay into a mix. That works, and it puts the obligation in the wrong place: the
	 * engine has to pass, as `targetSessionId`, the leg it would have called side `a`, which is a
	 * rule living in prose on both sides of a language border.
	 *
	 * `MediaPort.TapRequest` has carried `targetSide` since supervision was specified, because on
	 * ARI a tap is a direction on one channel and "speak to the agent" is only implementable once
	 * you know whether this channel is the agent. This is that field reaching the wire, so the
	 * engine states the fact it already holds instead of encoding it in an argument's position.
	 *
	 * ## Absent keeps the old convention, on purpose
	 *
	 * Optional rather than required, and absent means exactly what it meant before: the target is
	 * side `a` and the other party is side `b`. An engine that has not been taught to send it
	 * behaves as it always did, which is what lets the two ends roll independently — the rule this
	 * package's README states for every additive change.
	 *
	 * Meaningless in a room of more than two, where `a`/`b` are refused by name rather than
	 * resolved to whoever happens to be second in the join order.
	 */
	targetSide: z.enum(["a", "b"]).optional(),
	/**
	 * Which peers the supervisor hears. `none` is accepted by the enum and refused by the
	 * responder: a participant that hears nothing and (for an eavesdrop) says nothing is a port
	 * pair burning for no reason, and answering `ok` to it would hide a caller's bug.
	 */
	hear: mediaTapSideSchema.default("both"),
	/** Which peers hear the supervisor. `none` is the silent case and is the common one. */
	speakTo: mediaTapSideSchema.default("none"),
	/**
	 * The feature's own name for this combination, carried for the media plane's LOG only.
	 *
	 * Not authoritative: `hear`/`speakTo` are the contract, and a responder that branched on this
	 * instead would be able to disagree with them. It is here because "mediad opened a barge on
	 * session X" is a line an operator can read and `hear=both speakTo=both` is one they have to
	 * decode at three in the morning.
	 */
	mode: tapModeSchema.optional(),
});

export const mediaTapSessionResponseSchema = z.object({
	ok: z.boolean(),
	tapId: z.string().min(1).max(128),
	/** The bridge the tap joined, when it joined one. Empty on a refusal. */
	bridgeId: z.string().max(128).optional(),
	/** The sessions the tap is party to. Empty on a refusal. */
	sessionIds: z.array(z.string().max(128)).max(8).default([]),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaTapSessionRequest = z.infer<typeof mediaTapSessionRequestSchema>;
export type MediaTapSessionResponse = z.infer<typeof mediaTapSessionResponseSchema>;

export const MEDIA_TAP_SESSION_RPC = defineRpc(
	RPC_SUBJECTS.mediaTapSession,
	mediaTapSessionRequestSchema,
	mediaTapSessionResponseSchema,
	// The same 500 ms every other media command carries, and for the same reason: a supervisor
	// pressing `*0` is listening to silence until this returns.
	500,
);

/**
 * `rpc.media.v1.untap-session` — remove the tap, leave the conversation running.
 *
 * Keyed by `tapId` alone, exactly as `stop-playback` and `stop-recording` are keyed by their own
 * references: the engine's `MediaPort.stopTap(tapId)` carries nothing else, and a lookup by
 * reference is one the media plane can do without a scan.
 *
 * Idempotent. Untapping something already gone answers `ok: true, untapped: false` — the engine
 * retries an untap when a reply is lost, and a monitored conversation that survived the retry is
 * not a failure. It also NEVER ends the monitored call: a supervisor hanging up must leave the
 * customer talking to the agent, which is the one behaviour a mistake here would get wrong in the
 * most visible possible way.
 */
export const mediaUntapSessionRequestSchema = z.object({
	tapId: z.string().min(1).max(128),
});

export const mediaUntapSessionResponseSchema = z.object({
	ok: z.boolean(),
	tapId: z.string().min(1).max(128),
	/** False when there was no such tap. A SUCCESS, not a failure — see the note above. */
	untapped: z.boolean().default(false),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaUntapSessionRequest = z.infer<typeof mediaUntapSessionRequestSchema>;
export type MediaUntapSessionResponse = z.infer<typeof mediaUntapSessionResponseSchema>;

export const MEDIA_UNTAP_SESSION_RPC = defineRpc(
	RPC_SUBJECTS.mediaUntapSession,
	mediaUntapSessionRequestSchema,
	mediaUntapSessionResponseSchema,
	500,
);

// ---------------------------------------------------------------------------------------------
// rpc.media.v1.mute-session / hold-session — engine → mediad, rung 5's two state commands
// ---------------------------------------------------------------------------------------------

/**
 * Which half of a leg's audio path a mute applies to.
 *
 * The same three values `MediaPort.mute(channelId, direction)` uses and the same meanings ARI gives
 * them, so the two drivers cannot disagree about what a mute did. `in` is audio arriving FROM the
 * leg — the party cannot be heard; `out` is audio sent TO it — the party cannot hear.
 *
 * The default is `both`, which is ARI's own default for a mute with no direction. Matching it
 * matters more than picking the direction this platform would have chosen on its own.
 */
export const MEDIA_DIRECTIONS = ["in", "out", "both"] as const;
export const mediaDirectionSchema = z.enum(MEDIA_DIRECTIONS);
export type MediaDirection = (typeof MEDIA_DIRECTIONS)[number];

/**
 * `rpc.media.v1.mute-session` — stop audio flowing in one or both directions of one leg.
 *
 * ## Additive, and that is the contract rather than an implementation detail
 *
 * Muting `in` on a leg already muted `out` leaves BOTH muted. The alternative — a direction field
 * that replaces whatever was there — would make `mute(in)` on a leg that already could not hear
 * into an unmute of the direction nobody mentioned, which is how a conference participant gets
 * their audio back because somebody muted their microphone.
 *
 * `unmute: true` is what lifts one. One subject rather than a `mute-session`/`unmute-session` pair
 * because the two carry identical fields and differ in one bit — the same reasoning
 * {@link mediaHoldSessionRequestSchema} follows, and the opposite of the playback and recording
 * pairs, whose stop halves carry a reference and no other field at all.
 *
 * ## What it deliberately does NOT do
 *
 * It is not visible in SIP. A muted leg's far end is told nothing, its hold key does not light, and
 * it keeps sending. That is the whole difference from `hold-session` below, and it is why a
 * conference `*6` is this subject and an agent pressing hold is that one.
 *
 * It also does not gate DTMF DETECTION. A muted participant pressing `*6` to unmute themselves is
 * the single most common thing a muted participant does, and a media plane that suppressed the
 * keypress with the audio would make the unmute unreachable by exactly the people who need it.
 */
export const mediaMuteSessionRequestSchema = z.object({
	...mediaCommandShape,
	/** Which half of the path. `both` when omitted, which is ARI's default. */
	direction: mediaDirectionSchema.default("both"),
	/** `true` lifts the mute on {@link direction} instead of applying it. */
	unmute: z.boolean().default(false),
});

export const mediaMuteSessionResponseSchema = z.object({
	ok: z.boolean(),
	sessionId: z.string().min(1).max(128),
	/** The state AFTER the command: whether audio from the leg is suppressed. */
	mutedIn: z.boolean().default(false),
	/** The state AFTER the command: whether audio to the leg is suppressed. */
	mutedOut: z.boolean().default(false),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaMuteSessionRequest = z.infer<typeof mediaMuteSessionRequestSchema>;
export type MediaMuteSessionResponse = z.infer<typeof mediaMuteSessionResponseSchema>;

export const MEDIA_MUTE_SESSION_RPC = defineRpc(
	RPC_SUBJECTS.mediaMuteSession,
	mediaMuteSessionRequestSchema,
	mediaMuteSessionResponseSchema,
	// The family's 500 ms. Two atomic flags and a log line — there is no I/O on this path at all,
	// which is exactly what separates it from `hold-session` below.
	500,
);

/**
 * `rpc.media.v1.hold-session` — take a leg out of the conversation, optionally with music.
 *
 * ## Hold is a statement about the CONVERSATION, and mute is one about a direction
 *
 * `MediaPort` keeps them apart deliberately (`hold` is "SIGNALLING only, and deliberately separate
 * from startMusicOnHold") and so does this pair of subjects. A held party does not hear the other
 * side and the other side does not hear them; a muted party is one direction of one leg. A leg that
 * was muted before it was held stays muted when it is unheld, which is only expressible because
 * these are two commands over two pieces of state.
 *
 * The SIGNALLING half — the re-INVITE that lights the far end's hold key — is `apps/sipd`'s and
 * reaches the media plane as a repeat `allocate-session` carrying the new `direction`. This subject
 * is the media plane's own half, and an engine uses both, together or separately: a call held
 * mid-attended-transfer wants the music without the re-INVITE, because renegotiating twice in three
 * seconds is how phones drop audio.
 *
 * ## `music` is a media reference and the responder resolves it
 *
 * `moh:<class>` for a hold-music class, `sound:<name>` for a specific clip, `tone:silence` for a
 * deliberately silent hold — the same vocabulary `start-playback` takes, resolved through the same
 * library. Absent is a legal hold with NO music, which is what an instance with no music mounted
 * does: the caller hears silence, the conversation is still suppressed, and nothing pretends a file
 * existed.
 *
 * The hold STANDS even when the music cannot start. Failing a hold over its soundtrack would be
 * putting music ahead of privacy, and the party who pressed hold still expects the other side to
 * stop hearing them.
 *
 * ## Idempotent, in the shape every stop on this family uses
 *
 * `unhold: true` on a leg that was not held answers `ok: true, held: false` — a SUCCESS. The engine
 * retries an unhold after a lost reply, and a retry that answered "failed" would make a working
 * recovery look like a broken one. Holding a held leg re-points its music and answers `ok`.
 */
export const mediaHoldSessionRequestSchema = z.object({
	...mediaCommandShape,
	/** `true` returns the leg to the conversation and stops the music this hold started. */
	unhold: z.boolean().default(false),
	/**
	 * What the held party hears. `moh:<class>`, `sound:<name>`, `tone:silence`, or absent for a
	 * silent hold. Ignored when {@link unhold} is set.
	 */
	music: z.string().min(1).max(512).optional(),
	/**
	 * Caller-assigned reference for the music loop, so a `stop-playback` can name it.
	 *
	 * Optional because a hold with no music has no loop to name, and the responder mints one from
	 * the session id when music was asked for without a reference — an engine that only wants the
	 * suppression should not have to invent an id for a playback it will never stop by hand.
	 */
	musicRef: z.string().min(1).max(128).optional(),
});

export const mediaHoldSessionResponseSchema = z.object({
	ok: z.boolean(),
	sessionId: z.string().min(1).max(128),
	/** The state AFTER the command. `false` on an unhold of a leg that was not held — see above. */
	held: z.boolean().default(false),
	/** The reference the music loop is playing under, when there is one. */
	musicRef: z.string().max(128).optional(),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaHoldSessionRequest = z.infer<typeof mediaHoldSessionRequestSchema>;
export type MediaHoldSessionResponse = z.infer<typeof mediaHoldSessionResponseSchema>;

export const MEDIA_HOLD_SESSION_RPC = defineRpc(
	RPC_SUBJECTS.mediaHoldSession,
	mediaHoldSessionRequestSchema,
	mediaHoldSessionResponseSchema,
	// One second, not the family's 500 ms, and `start-playback` is the precedent: a hold that names
	// music READS AND DECODES A FILE before it answers, so the reply means the loop is in memory
	// rather than that the request was accepted for consideration. That disk read is the whole
	// difference, and it is why `mute-session` above keeps the shorter budget.
	1_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.engine.v1.originate — api → engine, click-to-call
// ---------------------------------------------------------------------------------------------

/**
 * Why an originate was refused.
 *
 * A refusal is a REPLY, as everywhere else on this backbone, and the codes are chosen so that
 * `apps/api` can map each one onto an HTTP status without consulting `error`: the person who
 * clicked a dial button needs "that extension is not registered" and "the platform is busy" to
 * look different, because only one of them is worth clicking again.
 */
export const ORIGINATE_REFUSAL_REASONS = [
	/** Malformed payload, or a required field missing. Retrying the same bytes fails the same way. */
	"bad_request",
	/**
	 * No extension in this tenant has that number.
	 *
	 * The tenant check is INSIDE this reason rather than beside it: an extension that exists in
	 * another organization must be indistinguishable from one that exists nowhere, or the endpoint
	 * becomes a cross-tenant extension oracle for anyone holding an API key.
	 */
	"unknown_extension",
	/**
	 * The extension exists and has no device the engine can ring — nothing registered, or every
	 * registration expired.
	 *
	 * Distinct from {@link unknown_extension} because the two need opposite things said: one is a
	 * typo in a CRM's configuration, the other is a phone that is unplugged, and only the second is
	 * worth retrying in a minute.
	 */
	"extension_offline",
	/**
	 * `to` resolves to nothing this tenant may dial — no matching route, or a destination the
	 * dial plan refuses.
	 *
	 * The toll-fraud boundary. The B-side is dialled AS THE EXTENSION, through the extension's own
	 * outbound routes, so a click-to-call cannot reach a destination the same person could not have
	 * dialled from their handset.
	 */
	"invalid_target",
	/** The engine, or the media plane under it, has no room for another call. A LOAD signal. */
	"capacity",
	/**
	 * This engine's media driver cannot originate at all.
	 *
	 * Named rather than folded into {@link internal} because it is a DEPLOYMENT fact with a fixed
	 * answer: `apps/mediad` refuses origination by design — SIP signalling belongs to `apps/sipd` —
	 * so an engine running `ENGINE_MEDIA_DRIVER=mediad` will refuse every one of these, forever, and
	 * the operator needs to see that rather than an intermittent-looking 500. It is the same
	 * distinction `MEDIA_REFUSAL_REASONS.not_supported` draws for the same reason.
	 */
	"not_supported",
	/** This instance is draining. Do not retry HERE — another one will take the queue-group message. */
	"shutting_down",
	/** Anything else. */
	"internal",
] as const;

export const originateRefusalReasonSchema = z.enum(ORIGINATE_REFUSAL_REASONS);
export type OriginateRefusalReason = (typeof ORIGINATE_REFUSAL_REASONS)[number];

/**
 * `rpc.engine.v1.originate` — the control plane asking the call engine to place a call.
 *
 * ## The classic click-to-call, and why the extension rings FIRST
 *
 * `POST /api/v1/calls {from, to}` is a CRM's dial button. What it means is "connect this person to
 * that number", and the only honest way to do that on a desk phone is to ring the person first and
 * dial the target when they pick up: the alternative — dialling the target first and then ringing
 * the extension — makes the far end listen to silence while somebody wanders back to their desk,
 * and charges the tenant for the attempt if they never do.
 *
 * So the A-leg is the extension, and the B-side dial happens on answer. That ordering is what makes
 * `extension_offline` a refusal the API can return SYNCHRONOUSLY, before anything is billed.
 *
 * ## RAW NATS ON BOTH ENDS, and why the queue group
 *
 * Both ends are NestJS, which by the rule of thumb at the head of this file would allow
 * `@MessagePattern`. It is raw anyway, for the reason `rpc.sip.v1.transfer` is: the engine already
 * serves its request-reply surface on the one raw connection it holds
 * (`apps/engine/src/nats/jetstream.service.ts`), and mixing a second transport into that surface for
 * one subject buys nothing and costs a framing mismatch the day a non-TypeScript caller appears.
 *
 * The subject is FLAT and served on the queue group `optimiq-engine-originate` — unlike
 * `rpc.engine.v1.park-handoff`, whose subject names one instance. A handoff moves a call that
 * already lives on exactly one engine; an originate CREATES one, so there is no owner to address
 * and any instance is the right answer.
 *
 * ## `originateId` is assigned by the CALLER, and is NOT the call id
 *
 * The caller-assigned half is there for the same reason `sessionId` and `bridgeId` are on the media
 * plane, and it bites harder here: a request whose reply is lost has still rung somebody's phone.
 * `originateId` becomes the MEDIA CHANNEL's id, so a retry of the same request finds a channel the
 * engine is already holding and is answered idempotently — with the ids of the call it already
 * placed — rather than ringing the desk a second time.
 *
 * It is deliberately not called `callId`, and the response carries `callId` and `legId` separately,
 * because the engine does not accept a call id from anybody: leg and call ids are DERIVED from the
 * media channel id by `channel-identity.ts`, so that an instance which picks a call up after a
 * failover arrives at the same ids and the CDR is not written twice. A contract that let a caller
 * name the call would be a contract that let a caller collide two of them.
 */
export const originateRequestSchema = z.object({
	/** The tenant. The responder re-checks every id against it rather than trusting the caller. */
	orgId: z.uuid(),
	/**
	 * The caller's handle on this origination, and the media channel's id. See the note above.
	 *
	 * A UUID rather than a free string so it is a valid channel-id token on every media driver and
	 * so two callers cannot collide by choosing the same friendly name.
	 */
	originateId: z.uuid(),
	/** The extension NUMBER to ring first — `1001`, not an extension row id. */
	fromExtension: dialStringSchema,
	/** What that extension is dialling, exactly as it would have typed it on the handset. */
	to: dialStringSchema,
	/**
	 * How long to ring the extension before giving up, in seconds.
	 *
	 * Bounded rather than open: an originate that rings forever is a channel and a media session
	 * held by a request nobody is waiting on any more. The engine's own default applies when absent.
	 */
	ringTimeoutSeconds: z.int().min(5).max(300).optional(),
	/**
	 * Caller ID to present to `to`, when the tenant wants something other than the extension's own.
	 *
	 * Advisory: the engine's outbound routing may still override it, exactly as it does for a call
	 * the extension dialled by hand. A contract that promised otherwise would be promising to
	 * bypass the tenant's own CLI policy.
	 */
	callerIdNumber: dialStringSchema.optional(),
	callerIdName: z.string().max(128).optional(),
	/**
	 * Who asked, for the engine's log and the CDR's provenance. A user id, an API key id, or a
	 * service name — never a credential.
	 */
	requestedBy: z.string().max(128).optional(),
});

export const originateResponseSchema = z.object({
	ok: z.boolean(),
	/** Echoed so a reply can be attributed without the requester holding per-request state. */
	originateId: z.string().min(1).max(128),
	/** The engine instance that took the call. Always present, refusal included, for the API's log. */
	instanceId: z.string().min(1).max(128).optional(),
	/**
	 * The call the engine created, on ITS terms — the token in
	 * `calls.evt.v1.<org>.<callId>.>` and the `call_id` every CDR leg carries. Present exactly when
	 * `ok`, and the whole reason this reply is worth waiting for: it is what lets the caller line
	 * the webhooks that are already arriving up against the button somebody pressed.
	 */
	callId: z.string().min(1).max(128).optional(),
	/** The A-leg — the extension's own leg. Present exactly when `ok`. */
	legId: z.string().min(1).max(128).optional(),
	/** The endpoint the A-leg was placed towards, for the support ticket. Diagnostics only. */
	endpoint: z.string().max(256).optional(),
	/** The destination after the plan's own normalisation, when it differs from `to`. */
	destination: dialStringSchema.optional(),
	reason: originateRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type OriginateRequest = z.infer<typeof originateRequestSchema>;
export type OriginateResponse = z.infer<typeof originateResponseSchema>;

export const ORIGINATE_RPC = defineRpc(
	RPC_SUBJECTS.engineOriginate,
	originateRequestSchema,
	originateResponseSchema,
	// Five seconds, and it is the longest deadline in this file by a wide margin.
	//
	// Nothing else here is bounded by a person: the media commands are socket work, and even the
	// park handoff is three ARI round trips. This one RESOLVES AN EXTENSION, looks up a registered
	// contact and asks the media server to create a channel — and it answers when the channel has
	// been CREATED, not when the phone has been answered, so the ring itself is outside the budget.
	// What five seconds buys is room for a media server under load; what it costs is a dial button
	// that spins for five seconds before saying so, which is the right trade against one that gives
	// up on a call the engine went on to place anyway.
	5_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.engine.v1.park-handoff — engine → engine, when a park is retrieved from the wrong node
// ---------------------------------------------------------------------------------------------

/**
 * Why a park handoff was refused.
 *
 * As with the media plane: a refusal is a REPLY. The retriever branches on this code and never on
 * `error`, because the four interesting outcomes need four different things said to the person who
 * dialled the orbit — "somebody already took that call", "that caller has hung up", "the call is
 * there but I cannot reach it", and "try again".
 */
export const PARK_HANDOFF_REFUSAL_REASONS = [
	/** Malformed payload, or a required field missing. Retrying the same bytes fails the same way. */
	"bad_request",
	/**
	 * This instance holds no park on that orbit.
	 *
	 * The RACE answer, and the common one: the claim the retriever read was a snapshot, and between
	 * the read and this request the call was collected locally, timed out back to its parker, or
	 * hung up. The retriever must say "no longer parked", NOT "parked elsewhere" — the search is
	 * over either way, but only one of those sends somebody looking for another engine.
	 */
	"not_parked",
	/**
	 * The orbit IS held here, by a different channel than the one the request named.
	 *
	 * A claim that was reaped and re-taken between the read and the request: the slot now holds
	 * somebody else's caller. Bridging them would connect the retriever to a stranger, which is the
	 * exact failure the whole claim mechanism exists to prevent, so it is refused rather than
	 * treated as a near-enough match.
	 */
	"claim_superseded",
	/** The parked leg has gone — hung up between the claim and the move. Nothing to hand over. */
	"channel_gone",
	/**
	 * The retriever's own channel is not visible to this instance's media server.
	 *
	 * The handoff bridges two channels from ONE side (see
	 * {@link parkHandoffRequestSchema}), which holds only while both engines drive the same media
	 * server. Two engines on two Asterisks is a supported deployment and a call parked on one of
	 * them genuinely cannot be collected from the other yet — so it is named, rather than surfacing
	 * as a media error the retriever cannot interpret.
	 */
	"unreachable_channel",
	/**
	 * The media server refused the move. The caller has been put BACK in their orbit and is still
	 * collectable — from the owning instance, and by a retry of this request.
	 */
	"media_failed",
	/** This instance is draining. Do not retry HERE. */
	"shutting_down",
	/** Anything else. */
	"internal",
] as const;

export const parkHandoffRefusalReasonSchema = z.enum(PARK_HANDOFF_REFUSAL_REASONS);
export type ParkHandoffRefusalReason = (typeof PARK_HANDOFF_REFUSAL_REASONS)[number];

/**
 * `rpc.engine.v1.park-handoff` — collect a call parked on ANOTHER engine instance.
 *
 * ## RAW NATS ON BOTH ENDS, even though both ends are NestJS
 *
 * The other raw family (`rpc.media.v1.*`) is raw because one end is Go. This one is raw for a
 * different reason, and it is worth stating because "both ends are Nest, so `@MessagePattern` is
 * fine" is the rule of thumb at the head of this file and this is the exception to it.
 *
 * The subject carries an INSTANCE TOKEN — `rpc.engine.v1.park-handoff.<instanceToken>`, built by
 * `subjectFor.engineParkHandoffRpc`. A Nest `@MessagePattern` is a fixed string decided at class
 * decoration time, and a `ClientProxy` sends to a pattern rather than to a subject; neither end can
 * express "the subject depends on which process is answering". The engine already holds a raw
 * connection (`apps/engine/src/nats/jetstream.service.ts`) and already speaks raw to `mediad`, so
 * the same transport serves this at no cost.
 *
 * ## Why the OWNING instance does the whole media move
 *
 * The obvious alternative is a split: the owner puts its parked channel in a bridge and answers
 * with the bridge id, and the retriever adds its own channel to it. That is tidier on paper and
 * worse in practice — it needs a SECOND round trip to undo the first when the retriever's half
 * fails, and until that round trip lands the caller is sitting in a bridge with nobody in it and no
 * longer in a lot anybody can dial. So the owner does both halves and the request carries the
 * retriever's channel: one operation, one outcome, and a failure path
 * ({@link ParkRegistry.restore}, on the owner) that already exists.
 *
 * The tradeoff, stated plainly: this works because both engines drive the SAME media server, where
 * a channel id is meaningful to either of them. Under the ARI driver that is the deployment the
 * `park-claims` bucket was built for in the first place — several engines behind one Asterisk. The
 * owner pre-flights the retriever's channel and refuses `unreachable_channel` when it cannot see
 * it, so the unsupported deployment fails with its own name rather than as a bridge error.
 *
 * ## Why the request names the parked channel
 *
 * Fencing. The retriever read the claim, and the claim may be stale by the time this arrives —
 * reaped and re-taken by a different caller. Naming the `mediaChannelId` it expects turns that from
 * "connected to a stranger" into `claim_superseded`.
 */
export const parkHandoffRequestSchema = z.object({
	/** The tenant. Both legs must belong to it; the owner re-checks rather than trusting it. */
	orgId: z.uuid(),
	parkLotId: z.string().min(1).max(128),
	/** The orbit being collected. */
	slot: z.int().min(0).max(1_000_000),
	/** The parked leg the retriever expects to find there. See the fencing note above. */
	mediaChannelId: z.string().min(1).max(128),
	/** The instance asking, for the owner's log and for a loop check. */
	retrieverInstanceId: z.string().min(1).max(128),
	/** The channel to bridge the parked caller to: the phone that dialled the orbit. */
	retrieverMediaChannelId: z.string().min(1).max(128),
	/** The retriever's leg id, which lands on the parked leg's CDR as its peer. */
	retrieverLegId: z.string().min(1).max(128),
	/**
	 * The bridge to build, assigned by the CALLER for the same reason `sessionId` is on the media
	 * plane: a request whose reply is lost must still name a thing the retriever can identify.
	 */
	bridgeId: z.string().min(1).max(128),
});

export const parkHandoffResponseSchema = z.object({
	ok: z.boolean(),
	parkLotId: z.string().max(128),
	slot: z.int().min(0).max(1_000_000),
	/** The instance that answered. Always present, including on a refusal, for the retriever's log. */
	instanceId: z.string().min(1).max(128),
	/** The bridge both legs are now in. Present exactly when `ok`. */
	bridgeId: z.string().min(1).max(128).optional(),
	/** The parked leg's ids, so the retriever can set its own CDR peer and log the pair. */
	legId: z.string().min(1).max(128).optional(),
	callId: z.string().min(1).max(128).optional(),
	/** When the call went into the lot, so the retriever can report how long it waited. */
	parkedAtMs: z.int().min(0).optional(),
	reason: parkHandoffRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type ParkHandoffRequest = z.infer<typeof parkHandoffRequestSchema>;
export type ParkHandoffResponse = z.infer<typeof parkHandoffResponseSchema>;

export const PARK_HANDOFF_RPC = defineRpc(
	RPC_SUBJECTS.engineParkHandoff,
	parkHandoffRequestSchema,
	parkHandoffResponseSchema,
	// Longer than the media plane's 500 ms, and deliberately so: this is not one socket operation
	// but a KV release plus three media-server calls on the far side, any of which is an HTTP round
	// trip under the ARI driver. It is still on a call path — somebody is holding a handset waiting
	// to be connected — so it is bounded well under the two seconds at which a person assumes the
	// feature is broken and hangs up.
	3_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.session.v1.announce.<orgId>.<application> — engine → api, when a call reaches an application
// ---------------------------------------------------------------------------------------------

/**
 * The session protocol's front door: a call has walked into an `application` destination and the
 * engine is offering it to whoever holds that application's socket.
 *
 * ## Why an offer and not a notification
 *
 * A caller is on the line while this is outstanding. The engine has to know, before it does
 * anything else, whether an application is going to take control of the leg or whether it must run
 * the destination's failure path — which is an announcement, because the alternative is dead air on
 * a call somebody's dial plan deliberately routed here. A published event cannot answer that; a
 * request can, and `no responders available` answers it INSTANTLY when nobody has claimed the
 * application (see {@link RPC_SUBJECTS.sessionAnnounce} for why the subject carries the name).
 *
 * ## What the answer contains, and what it does not
 *
 * `sessionId` and nothing else. The control plane does not get to rewrite the call: it cannot
 * change the caller id, cannot choose a different application and cannot pre-answer. Everything it
 * wants to do to the leg it does afterwards, one verb at a time, over
 * {@link RPC_SUBJECTS.engineSessionVerb} — where each command is authorised, guarded and logged on
 * its own. An accept that could also carry instructions would be a second, unaudited verb channel.
 */
export const SESSION_ANNOUNCE_REFUSAL_REASONS = [
	/** Nothing is registered for this application, or the socket went away mid-announce. */
	"no-application",
	/** The socket is registered but already holds as many sessions as it declared it can. */
	"at-capacity",
	/** The control plane is draining. */
	"shutting-down",
	"bad_request",
	"internal",
] as const;

export const sessionAnnounceRefusalReasonSchema = z.enum(SESSION_ANNOUNCE_REFUSAL_REASONS);
export type SessionAnnounceRefusalReason = (typeof SESSION_ANNOUNCE_REFUSAL_REASONS)[number];

export const sessionAnnounceRequestSchema = z.object({
	orgId: z.uuid(),
	/** The application name as the dial plan spelled it. Also a token of the subject. */
	application: z.string().min(1).max(128),
	callId: z.string().min(1).max(128),
	legId: z.string().min(1).max(128),
	/**
	 * The engine instance that owns the leg — the ADDRESS every later verb is sent to.
	 *
	 * Payload here, unlike the park handoff's `instanceId`, and the asymmetry is the point: a park
	 * handoff is addressed AT an instance the requester already knows, so carrying it in the body
	 * would be two places that could disagree. This one travels the other way — the responder learns
	 * it here and can learn it nowhere else, because a control plane holds no channel registry.
	 */
	instanceId: z.string().min(1).max(128),
	direction: callDirectionSchema,
	/** Whether the leg has already answered. An application must not assume it has. */
	answered: z.boolean(),
	callerIdNumber: dialStringSchema.optional(),
	callerIdName: z.string().max(128).optional(),
	/** What the caller dialled to get here, after the plan's normalisation. */
	dialedNumber: dialStringSchema.optional(),
	/**
	 * The destination's `args`, flattened to strings.
	 *
	 * The plan node models these as `string | number | boolean` and they arrive here as text,
	 * because the only consumer is an application that typed them into a form. Preserving the three
	 * JSON types across a wire, a Go struct and a browser would buy an integration nothing and would
	 * cost the Go emitter a union it cannot express.
	 */
	arguments: z.record(z.string().min(1).max(64), z.string().max(512)).optional(),
	at: z.iso.datetime(),
});

export const sessionAnnounceResponseSchema = z.object({
	accepted: z.boolean(),
	/** The control plane's handle for this session. Present exactly when `accepted`. */
	sessionId: z.string().min(1).max(128).optional(),
	reason: sessionAnnounceRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type SessionAnnounceRequest = z.infer<typeof sessionAnnounceRequestSchema>;
export type SessionAnnounceResponse = z.infer<typeof sessionAnnounceResponseSchema>;

export const SESSION_ANNOUNCE_RPC = defineRpc(
	RPC_SUBJECTS.sessionAnnounce,
	sessionAnnounceRequestSchema,
	sessionAnnounceResponseSchema,
	// Two seconds, and the shortest budget of any subject on a call path here. Everything this
	// asks for is in memory on the far side — is a socket registered, and does it have room — so a
	// reply that takes longer than this is a control plane in trouble, and the honest thing to do
	// with a caller listening to silence is to stop waiting and announce.
	2_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.engine.v1.session-verb.<instanceToken> — api → engine, one command on one leg
// ---------------------------------------------------------------------------------------------

/**
 * The verbs the session protocol will carry.
 *
 * A CLOSED list, and deliberately shorter than `packages/telephony`'s 28-member `Verb` union: it is
 * exactly what `apps/engine`'s verb executor implements. The eight it omits — `earlyMedia`, `say`,
 * `stopSay`, `playbackControl`, `stream`, `stopStream`, `streamGather`, `stopStreamGather` — are
 * refused by the executor for stated reasons, and refusing them HERE, at the wire, is a better
 * answer than accepting a command and failing it one hop later: an application gets the refusal
 * from its own schema validation instead of from a call that is already in progress.
 *
 * When one of them lands, it is added here and to the executor in the same change. That coupling is
 * the feature.
 */
export const SESSION_VERBS = [
	"answer",
	"ringing",
	"play",
	"stopPlay",
	"gather",
	"record",
	"dial",
	"bridge",
	"unbridge",
	"transfer",
	"hold",
	"unhold",
	"park",
	"unpark",
	"playDtmf",
	"mute",
	"unmute",
	"setVariable",
	"sleep",
	"hangup",
] as const;

export const sessionVerbNameSchema = z.enum(SESSION_VERBS);
export type SessionVerbName = (typeof SESSION_VERBS)[number];

/** One leg a session's `dial` may originate, in the order the engine will try them. */
export const sessionDialTargetSchema = z.object({
	destination: dialStringSchema,
	/**
	 * The routing namespace to resolve the destination in.
	 *
	 * `internal` then `outbound` when omitted, which is exactly what `*69` does — and the reason
	 * this field exists rather than the engine always guessing: an application that means "ring
	 * extension 1001" and an application that means "dial the PSTN number 1001" are asking for
	 * different things, and only one of them may pass the toll gate.
	 */
	context: z.enum(["internal", "outbound"]).optional(),
});

/**
 * Every argument any verb in {@link SESSION_VERBS} takes, as one flat object.
 *
 * ## Why flat, and not a discriminated union
 *
 * Because this contract crosses a language border. `packages/events-go`'s emitter turns each schema
 * here into a Go struct, and it has no representation for a tagged union — a `z.discriminatedUnion`
 * emits `anyOf`, which the emitter refuses rather than guesses at. The alternatives were to keep the
 * verb payload out of the contract entirely (an opaque blob, so neither end could validate it) or to
 * emit twenty request schemas for one subject. A flat argument record with a `verb` discriminant
 * beside it is the same shape ESL's `execute <app> <args>` and ARI's operation bodies have, for the
 * same reason, and it keeps ONE schema per subject.
 *
 * The cost is real and worth naming: a `play` carrying `maxDigits` validates here and is ignored by
 * the engine. What is NOT lost is the important half — the engine narrows on `verb` and reads only
 * the fields that verb has, so a missing REQUIRED argument is still a typed refusal rather than an
 * `undefined` reaching the media server.
 */
export const sessionVerbArgumentsSchema = z.object({
	// play / gather / stopPlay
	/** `sound:`/`object://` media reference for `play`, or a `gather` prompt. */
	media: z.string().max(512).optional(),
	playbackRef: z.string().max(128).optional(),
	loop: z.int().min(0).max(1_000).optional(),
	terminators: z.array(dtmfDigitSchema).max(16).optional(),
	// gather
	maxDigits: z.int().min(1).max(64).optional(),
	timeoutMs: z.int().min(0).max(600_000).optional(),
	interDigitTimeoutMs: z.int().min(0).max(600_000).optional(),
	regex: z.string().max(256).optional(),
	// record
	maxDurationMs: z
		.int()
		.min(0)
		.max(24 * 60 * 60 * 1_000)
		.optional(),
	silenceStopMs: z.int().min(0).max(600_000).optional(),
	beep: z.boolean().optional(),
	format: z.enum(["wav", "mp3", "ogg"]).optional(),
	// dial
	targets: z.array(sessionDialTargetSchema).min(1).max(16).optional(),
	/**
	 * `sequential` only, today.
	 *
	 * `simultaneous` is accepted by the schema and REFUSED by the engine, which is the honest split:
	 * ring-all with lose-race semantics and CDR-correct losers is the plan walker's, and a second
	 * originator in the verb executor would be a second, subtly different one. Declaring the value
	 * means an application that wants it gets a refusal naming it, rather than a validation error
	 * that reads like the field does not exist.
	 */
	strategy: z.enum(["sequential", "simultaneous"]).optional(),
	continueOnCauses: z.array(hangupCauseSchema).max(32).optional(),
	// bridge
	/** The DOMAIN leg id to join to — never a media-server channel id. */
	peerLegId: z.string().max(128).optional(),
	// transfer
	transferKind: transferKindSchema.optional(),
	destination: dialStringSchema.optional(),
	destinationContext: z.string().max(64).optional(),
	fallbackDestination: dialStringSchema.optional(),
	cancelKey: dtmfDigitSchema.optional(),
	// hold / park / unpark
	musicOnHold: z.string().max(128).optional(),
	soft: z.boolean().optional(),
	lot: z.string().max(128).optional(),
	orbit: z.string().max(32).optional(),
	// playDtmf
	digits: z.array(dtmfDigitSchema).min(1).max(64).optional(),
	toneDurationMs: z.int().min(0).max(10_000).optional(),
	// mute / unmute
	direction: z.enum(["in", "out", "both"]).optional(),
	// sleep
	durationMs: z.int().min(0).max(600_000).optional(),
	// setVariable
	name: z.string().max(128).optional(),
	value: z.string().max(1_024).optional(),
	scope: z.enum(["channel", "export", "global"]).optional(),
	// hangup
	cause: hangupCauseSchema.optional(),
});

export const sessionVerbRequestSchema = z.object({
	orgId: z.uuid(),
	/** The session the announcement opened. Checked against the leg — see the response's refusals. */
	sessionId: z.string().min(1).max(128),
	callId: z.string().min(1).max(128),
	legId: z.string().min(1).max(128),
	verb: sessionVerbNameSchema,
	arguments: sessionVerbArgumentsSchema.optional(),
});

/**
 * Why a verb did not run. Distinct from a verb that ran and ended badly, which is `ok` with an
 * `endReason` — a `gather` that timed out did exactly what it was asked to.
 */
export const SESSION_VERB_REFUSAL_REASONS = [
	"bad_request",
	/** No leg with that id on this instance: it ended, or the session named someone else's call. */
	"unknown-leg",
	/** The session id does not match the one this leg was announced under. */
	"session-mismatch",
	/** The executor refused it — tearing down, no media path, or a scope it does not implement. */
	"not-permitted",
	/** The executor does not implement this verb yet. */
	"unsupported",
	"shutting-down",
	"internal",
] as const;

export const sessionVerbRefusalReasonSchema = z.enum(SESSION_VERB_REFUSAL_REASONS);
export type SessionVerbRefusalReason = (typeof SESSION_VERB_REFUSAL_REASONS)[number];

/**
 * What one verb did.
 *
 * Flat for the same reason the arguments are, and with the same trade: every result field any verb
 * can produce lives here, and a verb fills in the ones it has. The discriminant is `verb`, echoed
 * back so a client that pipelined two commands can tell the answers apart.
 */
export const sessionVerbResponseSchema = z.object({
	ok: z.boolean(),
	verb: sessionVerbNameSchema,
	/** The instance that answered. Always present, including on a refusal, for the caller's log. */
	instanceId: z.string().min(1).max(128),
	/** How the verb ended. Present exactly when `ok`. */
	endReason: z
		.enum(["completed", "terminator", "timeout", "cancelled", "hangup", "failed"])
		.optional(),
	reason: sessionVerbRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
	// play
	playbackRef: z.string().max(128).optional(),
	elapsedMs: z.int().min(0).optional(),
	// gather
	digits: z.array(dtmfDigitSchema).max(64).optional(),
	// record
	recordingId: z.string().max(128).optional(),
	mediaRef: z.string().max(512).optional(),
	durationMs: z.int().min(0).optional(),
	format: z.string().max(16).optional(),
	// dial
	/** Which entry of `targets` answered, when one did. */
	answeredTargetIndex: z.int().min(0).optional(),
	cause: hangupCauseSchema.optional(),
	// bridge
	bridgeId: z.string().max(128).optional(),
});

export type SessionVerbRequest = z.infer<typeof sessionVerbRequestSchema>;
export type SessionVerbResponse = z.infer<typeof sessionVerbResponseSchema>;
export type SessionVerbArguments = z.infer<typeof sessionVerbArgumentsSchema>;
export type SessionDialTarget = z.infer<typeof sessionDialTargetSchema>;

export const SESSION_VERB_RPC = defineRpc(
	RPC_SUBJECTS.engineSessionVerb,
	sessionVerbRequestSchema,
	sessionVerbResponseSchema,
	// Thirty seconds, and by far the longest budget on this backbone — because unlike every other
	// subject here, some of these verbs are supposed to take a long time. A `gather` waits for a
	// person to finish dialling and a `dial` waits for a phone to be answered; both are bounded by
	// their own `timeoutMs`, which the schema caps at ten minutes, and neither is "slow" at twenty
	// seconds. This deadline therefore is not a latency budget, it is a LIVENESS one: past it the
	// engine is not thinking, it is gone, and the control plane should tell the socket so rather
	// than hold a verb open forever. An application that wants a longer ring sends `dial` with the
	// timeout it wants and reads the result off the call events.
	30_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.engine.v1.conference-control.<instanceToken> — api → engine, moderating a live room
// ---------------------------------------------------------------------------------------------

/**
 * What a moderator can do to a live conference.
 *
 * A CLOSED list, and the split down the middle of it is the important part: the first five act on
 * ONE MEMBER and the last two act on the ROOM. That difference decides who can serve the command —
 * a member lives on exactly one engine instance's media channel, a room's lock is cluster state
 * held in the `conference-claims` value — and it is why {@link conferenceControlRequestSchema}
 * makes `memberRef` conditionally required rather than always.
 *
 * `deaf` is `mute` in the other direction and is a separate verb rather than a direction argument
 * on `mute`, because they are different acts with different consequences: muting somebody stops the
 * room hearing them, deafening them stops them hearing the room, and a moderation UI that offered
 * one control with a direction dropdown would be describing a mixer rather than a meeting.
 *
 * `volume` is here and is REFUSED by one of the two media drivers, which is stated on the response
 * rather than hidden: see {@link CONFERENCE_CONTROL_REFUSAL_REASONS}.
 */
export const CONFERENCE_CONTROL_ACTIONS = [
	/** The room stops hearing this member. `*6` from the handset does the same thing. */
	"mute",
	"unmute",
	/** This member stops hearing the room. Their own audio still reaches it unless also muted. */
	"deaf",
	"undeaf",
	/**
	 * Remove this member from the room.
	 *
	 * It does NOT hang the call up, and the difference matters to whoever is holding the phone: a
	 * kicked participant is out of the meeting and still on a call the engine can route somewhere
	 * — today, to a goodbye announcement and a hangup, which is a routing decision and therefore
	 * the engine's rather than the media plane's.
	 */
	"kick",
	/**
	 * Re-level one member's contribution to the mix, or what they hear of it.
	 *
	 * Servable only on a media plane that MIXES. See the `not-servable` refusal.
	 */
	"volume",
	/** The room stops admitting new participants. Acts on the room; carries no `memberRef`. */
	"lock",
	"unlock",
] as const;

export const conferenceControlActionSchema = z.enum(CONFERENCE_CONTROL_ACTIONS);
export type ConferenceControlAction = (typeof CONFERENCE_CONTROL_ACTIONS)[number];

/** The two verbs that act on the room rather than on one member. */
export const CONFERENCE_ROOM_ACTIONS = ["lock", "unlock"] as const;

/**
 * `rpc.engine.v1.conference-control.<instanceToken>` — one moderation command on one live room.
 *
 * ## Instance-addressed, and the address is read out of the claim
 *
 * See {@link RPC_SUBJECTS.engineConferenceControl}. The short version: a room is jointly held, so
 * there is no single instance that owns it, but every MEMBER is on exactly one instance's media
 * channel and only that instance can mute it. The control plane reads the room's
 * `conference-claims` value, which already names every instance with unexpired members in it, and
 * addresses each in turn until one answers something other than `unknown-member`.
 *
 * ## `memberRef` is the LEG id, not a media channel id
 *
 * The control plane never sees a media channel id and must not: it is the engine's own handle onto
 * a media server, it changes when the media driver changes, and a REST path segment carrying one
 * would be an Asterisk-ism in a URL. The leg id is what `conference.joined` publishes, which is the
 * only place the control plane learns a participant exists at all, so it is the only identifier
 * both ends already share.
 *
 * ## Room verbs go to any contributor, and the lock lands in the CLAIM
 *
 * `lock` is not a fact about one instance's copy of the room — a join landing on a neighbour has to
 * be refused too, or the lock is a suggestion. So the instance that serves it writes the flag into
 * the shared claim under compare-and-set, and every joiner reads it on the join path it already
 * reads the member cap on. Which contributor serves the command is therefore irrelevant, and a
 * deployment with no claim bucket configured is single-instance by choice and locks locally.
 */
export const conferenceControlRequestSchema = z.object({
	orgId: z.uuid(),
	/** The room, as `conference.id`. The same id `conference.joined` carries. */
	conferenceId: z.uuid(),
	action: conferenceControlActionSchema,
	/**
	 * The member to act on — a LEG id. Required for every action except `lock` and `unlock`, and
	 * refused as `bad-request` when it is missing.
	 */
	memberRef: z.string().min(1).max(128).optional(),
	/**
	 * Gain for `volume`, in PERCENT of unity, 0–400.
	 *
	 * Percent rather than decibels because the only caller is a slider in a moderation panel and a
	 * dB scale would need a curve at both ends to be usable; percent rather than the mixer's own
	 * Q8 fixed point because that is an implementation's unit and this is a contract. 100 is
	 * unchanged, 0 is silent, and the ceiling is 400 because a member amplified past four times
	 * unity is clipping rather than louder.
	 */
	gainPercent: z.int().min(0).max(400).optional(),
	/**
	 * Which half of `volume` to set. `talk` is the member's contribution TO the room, `listen` is
	 * what they hear OF it. `both` when omitted.
	 */
	gainScope: z.enum(["talk", "listen", "both"]).optional(),
	/** Who asked, for the audit trail and the log line. The control plane's user id. */
	byUserId: z.uuid().optional(),
});

/**
 * Why a moderation command did not run.
 *
 * `not-servable` is the one worth reading twice. It is not "this engine is broken" and not "this
 * release has not built it" — it is **the media plane under this call cannot express the request**,
 * and the caller's recovery is to stop offering the control rather than to retry. Today it is
 * produced by exactly one combination: `volume` on the ARI driver, which can mute a channel and has
 * no per-participant gain on a mixing bridge at all. `error` names the driver so an operator can
 * see why the same button worked on a different call.
 */
export const CONFERENCE_CONTROL_REFUSAL_REASONS = [
	/** Malformed payload, a missing `memberRef`, or a `gainPercent` on something that is not `volume`. */
	"bad-request",
	/** No room with that id on this instance. The caller should try the next contributor. */
	"unknown-conference",
	/** The room is here and that member is not. The caller should try the next contributor. */
	"unknown-member",
	/**
	 * The media plane under this call cannot serve the action. NOT a rung and NOT a retry — see
	 * the note above.
	 */
	"not-servable",
	/** The media plane accepted the idea and refused the command. `error` carries its reason. */
	"media-refused",
	"shutting-down",
	"internal",
] as const;

export const conferenceControlRefusalReasonSchema = z.enum(CONFERENCE_CONTROL_REFUSAL_REASONS);
export type ConferenceControlRefusalReason = (typeof CONFERENCE_CONTROL_REFUSAL_REASONS)[number];

/**
 * What one moderation command did.
 *
 * It answers with the member's WHOLE state afterwards rather than an acknowledgement, for the
 * reason `conference.participant.updated` carries the whole state: a moderation panel that applied
 * a delta to a row it had drawn from a missed frame would show a mute button that disagrees with
 * the mixer.
 */
export const conferenceControlResponseSchema = z.object({
	ok: z.boolean(),
	action: conferenceControlActionSchema,
	/** The instance that answered. Always present, including on a refusal, for the caller's log. */
	instanceId: z.string().min(1).max(128),
	/** Members in the room, cluster-wide, after the command. */
	memberCount: z.int().min(0).default(0),
	/** Whether the room is admitting new participants. Present on every reply that found the room. */
	locked: z.boolean().optional(),
	/** The member acted on, echoed back, when the action named one. */
	memberRef: z.string().max(128).optional(),
	/** The member's state AFTER the command. Absent on a `kick` and on the room verbs. */
	muted: z.boolean().optional(),
	deafened: z.boolean().optional(),
	moderator: z.boolean().optional(),
	talkGainPercent: z.int().min(0).max(400).optional(),
	listenGainPercent: z.int().min(0).max(400).optional(),
	reason: conferenceControlRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type ConferenceControlRequest = z.infer<typeof conferenceControlRequestSchema>;
export type ConferenceControlResponse = z.infer<typeof conferenceControlResponseSchema>;

export const CONFERENCE_CONTROL_RPC = defineRpc(
	RPC_SUBJECTS.engineConferenceControl,
	conferenceControlRequestSchema,
	conferenceControlResponseSchema,
	// Two seconds. Everything on the far side is in memory except one media command, whose own
	// budget is 500 ms — so this is that plus a claim write plus room to be wrong about the network,
	// and past it the instance is not thinking, it is gone. The api tries the next contributor.
	2_000,
);

/** Every request-reply contract, keyed by subject. */
export const RPC_CONTRACTS = {
	[RPC_SUBJECTS.routingResolve]: ROUTING_RESOLVE_RPC,
	[RPC_SUBJECTS.authzCheck]: AUTHZ_CHECK_RPC,
	[RPC_SUBJECTS.voicemailList]: VOICEMAIL_LIST_RPC,
	[RPC_SUBJECTS.pbxExtensionFeature]: EXTENSION_FEATURE_RPC,
	[RPC_SUBJECTS.pbxLastCaller]: LAST_CALLER_RPC,
	[RPC_SUBJECTS.pbxFileGreeting]: FILE_GREETING_RPC,
	[RPC_SUBJECTS.sipCredential]: SIP_CREDENTIAL_RPC,
	[RPC_SUBJECTS.sipTransfer]: SIP_TRANSFER_RPC,
	[RPC_SUBJECTS.mediaAllocateSession]: MEDIA_ALLOCATE_SESSION_RPC,
	[RPC_SUBJECTS.mediaBridgeSessions]: MEDIA_BRIDGE_SESSIONS_RPC,
	[RPC_SUBJECTS.mediaUnbridgeSessions]: MEDIA_UNBRIDGE_SESSIONS_RPC,
	[RPC_SUBJECTS.mediaReleaseSession]: MEDIA_RELEASE_SESSION_RPC,
	[RPC_SUBJECTS.mediaStartPlayback]: MEDIA_START_PLAYBACK_RPC,
	[RPC_SUBJECTS.mediaStopPlayback]: MEDIA_STOP_PLAYBACK_RPC,
	[RPC_SUBJECTS.mediaSendDtmf]: MEDIA_SEND_DTMF_RPC,
	[RPC_SUBJECTS.mediaStartRecording]: MEDIA_START_RECORDING_RPC,
	[RPC_SUBJECTS.mediaStopRecording]: MEDIA_STOP_RECORDING_RPC,
	[RPC_SUBJECTS.mediaTapSession]: MEDIA_TAP_SESSION_RPC,
	[RPC_SUBJECTS.mediaUntapSession]: MEDIA_UNTAP_SESSION_RPC,
	[RPC_SUBJECTS.mediaMuteSession]: MEDIA_MUTE_SESSION_RPC,
	[RPC_SUBJECTS.mediaHoldSession]: MEDIA_HOLD_SESSION_RPC,
	[RPC_SUBJECTS.engineOriginate]: ORIGINATE_RPC,
	[RPC_SUBJECTS.engineParkHandoff]: PARK_HANDOFF_RPC,
	[RPC_SUBJECTS.engineSessionVerb]: SESSION_VERB_RPC,
	[RPC_SUBJECTS.engineConferenceControl]: CONFERENCE_CONTROL_RPC,
	[RPC_SUBJECTS.sessionAnnounce]: SESSION_ANNOUNCE_RPC,
} as const;
