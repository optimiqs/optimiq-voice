/**
 * The Optimiq Voice permission registry — the single source of truth for authorization.
 *
 * FusionPBX carried ~940 field-level permissions; this collapses them to a
 * `<resource>.<action>[.<scope>]` model. `resource` and `action` are kebab-case; `scope` is
 * drawn from a closed set and narrows a permission to a subset of the organization's rows:
 *
 * - no scope — organization-wide
 * - `own`    — only rows the acting user owns (their extension, their voicemail, their calls)
 * - `team`   — rows belonging to a team/queue the user is a member of (reserved for T2 ACD)
 * - `all`    — crosses the organization boundary; platform-operator surface only
 *
 * `apps/api` consumes this through a `@RequirePermissions(...)` guard, and a sync-permissions
 * codegen step mirrors it into the web app (the oikos cross-repo contract bridge). Adding a
 * permission here is the only supported way to introduce one.
 */

export const PERMISSION_SCOPES = ["own", "team", "all"] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/** Every permission string must match this shape; enforced by spec. */
export const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*(?:\.(?:own|team|all))?$/u;

export const PERMISSIONS = [
	// --- Telephony inventory -------------------------------------------------
	"extensions.read",
	"extensions.read.own",
	"extensions.write",
	"extensions.write.own",
	"extensions.delete",
	"extensions.assign",

	"devices.read",
	"devices.read.own",
	"devices.write",
	"devices.delete",

	"numbers.read",
	"numbers.write",
	/**
	 * Buying a DID from the managed carrier.
	 *
	 * Split from `numbers.write` because the two differ in the only way that matters here: writing
	 * changes how a number the organization already owns behaves, ordering **spends the
	 * organization's money on a recurring commitment**. A manager who may re-point a DID at a
	 * different IVR should not, by that fact alone, be able to add a line to the monthly bill. It
	 * is the sharpest boundary in the carrier feature, and the only one that earned its own entry —
	 * see the header of `apps/api/src/pbx/carrier/carrier.module.ts` for why release and trunk
	 * provisioning deliberately did not.
	 */
	"numbers.order",
	"numbers.delete",
	"numbers.assign",
	"numbers.emergency",

	"trunks.read",
	"trunks.write",
	"trunks.delete",

	// --- Routing -------------------------------------------------------------
	"routes.read",
	"routes.write",
	"routes.delete",
	"routes.publish",
	"routes.simulate",

	"time-conditions.read",
	"time-conditions.write",
	"time-conditions.delete",

	"feature-codes.read",
	"feature-codes.write",
	"feature-codes.delete",

	/**
	 * Caller screening: the allow/deny list every inbound and outbound leg is checked against.
	 *
	 * Its own resource rather than a ride on `routes.*`, and the argument is the same shape as the
	 * one that gave `security.*` its own pair. `routes.write` is the dial plan — which menu answers
	 * which DID, which trunk carries which prefix — and it is held by whoever owns the telephony
	 * configuration. A screening list is the organization's answer to a specific caller, and the
	 * person who maintains it is whoever picked up the phone. Riding it on `routes.write` would mean
	 * the only way to let a receptionist block a number is to hand them the outbound routing table.
	 *
	 * The reverse direction is what settled it. `block` is the harmless action; **`allow` is the
	 * dangerous one**, because an allow rule is precisely what lifts a number back OUT of a broad
	 * prefix block. Whoever holds this grant can quietly re-admit a caller the organization decided
	 * to exclude, and that is a decision worth naming in its own audit row instead of appearing as
	 * "edited routing".
	 *
	 * THREE entries, and the delete is the one that needed proving. Elsewhere in this registry a
	 * rule-shaped resource gets no delete grant — `security.delete` and `webhooks.delete` were both
	 * refused on the argument that disabling a rule and removing it stop the same thing with the
	 * same consequence. A block rule breaks that tie because it accumulates evidence: `hit_count`
	 * and `last_hit_at` are what turn "somebody added this number once" into "this number called
	 * forty times last week". Disabling keeps that; deleting destroys it. That is a record, not a
	 * rule, and destroying records is what a delete grant is for.
	 */
	"call-block.read",
	"call-block.write",
	"call-block.delete",

	// --- Call features -------------------------------------------------------
	"ivr.read",
	"ivr.write",
	"ivr.delete",
	"ivr.publish",

	"ring-groups.read",
	"ring-groups.write",
	"ring-groups.delete",

	"paging-groups.read",
	"paging-groups.write",
	"paging-groups.delete",

	"shared-lines.read",
	"shared-lines.write",
	"shared-lines.delete",

	"queues.read",
	"queues.write",
	"queues.delete",
	"queues.manage-agents",
	"queues.monitor",
	"queues.join",
	"queues.join.own",

	"voicemail.read",
	"voicemail.read.own",
	"voicemail.write",
	"voicemail.delete",
	"voicemail.delete.own",
	"voicemail.listen",
	"voicemail.listen.own",

	"conferences.read",
	"conferences.write",
	"conferences.delete",
	/**
	 * Mid-call control of a LIVE room: mute, deafen, kick, re-level, lock.
	 *
	 * Retired once and back with its endpoints, which is the bar the header at the top of this file
	 * sets and the bar `RETIRED_PERMISSIONS` restates. The reason it was retired — "mid-call control
	 * is not exposed over HTTP at all on this platform" — stopped being true when
	 * `POST /conferences/:id/participants/:ref/mute` landed, and it returns in the same change.
	 *
	 * Deliberately NOT a guard on the CRUD routes, which is what `conferences.controller.ts` has said
	 * in its header since it was written: muting a participant and re-pointing a room's recording
	 * policy are different powers, and a supervisor who may do the first must not thereby be able to
	 * do the second. It is also not what the PIN endpoints ride on, for the sharper version of the
	 * same argument — a stored credential decides who may ENTER the room.
	 */
	"conferences.moderate",

	"park-lots.read",
	"park-lots.write",
	"park-lots.delete",

	/**
	 * Fax servers, their inbox/outbox, and the send action.
	 *
	 * A trio plus a `send`, the same shape `queues` takes with `join`: the read/write/delete run the
	 * fax-server configuration (which DID sends and receives, the header, the fax-to-email address,
	 * the retry policy), and `send` is the distinct act of pushing a document out through the carrier.
	 * `send` is split from `write` for the reason `numbers.order` is split from `numbers.write`: one
	 * changes configuration and the other spends money on the PSTN, and a role may reasonably hold one
	 * without the other. There is no `.own` scope — a fax line is org-level infrastructure, not a
	 * per-user mailbox, so this is an admin/manager feature and never reaches the self-service roles.
	 */
	"faxes.read",
	"faxes.write",
	"faxes.delete",
	"faxes.send",

	/**
	 * The day/night switch, and the one grant in this registry that a receptionist holds.
	 *
	 * `toggle` is separate from `write` because the two are different jobs done by different people.
	 * `write` decides WHERE the day branch and the night branch go, which is configuration an
	 * administrator sets once. `toggle` moves the switch, which is what somebody at the front desk
	 * does at five o'clock and again when the office closes early for a funeral — it is the entire
	 * reason the feature exists, and putting it behind `write` would mean the person who needs it
	 * every day also holds the grant that re-points the tenant's inbound calls.
	 *
	 * It gates the TIME-CONDITION override as well, and that is a deliberate collapse rather than an
	 * oversight. Forcing a time condition open and flipping a call flow to night are the same act —
	 * a human overruling where calls go, right now — and they differ only in which table the state
	 * lives in. A separate `time-conditions.override` would be a second name for one power, which is
	 * the field-level granularity this registry exists to undo. Editing the RULES stays on
	 * `time-conditions.write`, because that is configuration and not an override.
	 */
	"call-flows.read",
	"call-flows.write",
	"call-flows.delete",
	"call-flows.toggle",

	/**
	 * Outbound authorisation codes.
	 *
	 * Its own resource rather than a ride on `routes.write`, and the argument is the one
	 * `numbers.order` and `calls.originate` both made: the blast radius is money. A PIN set is the
	 * gate in front of a tenant's expensive routes, and the same grant that adds a code removes one —
	 * so a holder can make an international route dialable by everybody in the building. That is a
	 * strictly larger power than re-ordering a trunk list, which is what `routes.write` otherwise
	 * covers, and it belongs to somebody who can be named when the bill arrives.
	 *
	 * `read` is a real grant despite there being no secret to read: the digests never leave the
	 * process, so what a reader sees is which routes are gated and by whose codes — which is exactly
	 * what somebody diagnosing "why is this phone asking me for a number" needs.
	 */
	"pin-sets.read",
	"pin-sets.write",
	"pin-sets.delete",

	/**
	 * The named routing building blocks: destination aliases, audio streams, organization speed
	 * dials, and the dial-by-name directory.
	 *
	 * ONE resource for four tables, and this is the collapse the registry's header asks every wave to
	 * justify. The test is whether the four have DIFFERENT power profiles, and they do not: each is a
	 * named thing an administrator points other routing at, none of them reaches a trunk except
	 * through the outbound tables every other destination goes through, and there is no role that
	 * plausibly edits one and not the others. Four trios would be twelve permissions expressing one
	 * decision, which is precisely the ~940-permission shape this model replaced.
	 *
	 * Number-translation rulesets are NOT here, and are not a resource of their own either: they are
	 * only meaningful attached to an outbound route or a trunk, and their power — deciding what goes
	 * on the wire — is the power a route already has. They ride `routes.*`, which is the grant that
	 * already decides which digits reach which carrier.
	 *
	 * Phrases are not here either, for the same reason one layer over: a phrase IS a `prompt` row, so
	 * it rides `recordings.*` with the rest of the media library.
	 */
	"dial-plan.read",
	"dial-plan.write",
	"dial-plan.delete",

	/**
	 * Per-organization quotas, and the one entry in this registry that is honestly in the wrong place.
	 *
	 * A limit an administrator can raise is not a limit. The correct owner is a PLATFORM OPERATOR —
	 * upstream's parent-domain, the reseller hierarchy this plan calls W14 — and that surface does not
	 * exist yet. So the interim is stated rather than smuggled: `write` is held by `owner` alone, which
	 * is the narrowest boundary this model can currently express, and `ADMIN_PERMISSIONS` excludes it
	 * alongside `settings.write.all` for exactly that reason.
	 *
	 * It is not a real control-plane boundary and does not pretend to be one — an owner can raise
	 * their own cap. What it buys is that the columns, the enforcement and the usage accounting exist
	 * and are tested, so W14 moves a permission and a controller rather than building the feature.
	 *
	 * `read` is much wider, because the usage screen is a support tool: "you are at 48 of 50
	 * extensions" is the answer to a ticket, and hiding it from the people who field those tickets
	 * would make the limit surface as a create button that fails.
	 */
	"org-limits.read",
	"org-limits.write",

	/**
	 * Placing a call from the platform: `POST /api/v1/calls`, the click-to-call button.
	 *
	 * ONE entry, and the first member of a `calls` resource that has never existed — so here is the
	 * proof the ceiling's instruction asks for, and the argument against the two alternatives.
	 *
	 * It is not a ride on `extensions.write`. That grant is CONFIGURATION: it changes what an
	 * extension is, on a screen an administrator visits occasionally. This one makes a phone ring
	 * and, when the destination is off-net, spends the organization's money on a trunk minute at a
	 * rate set by whoever is holding the API key. The blast radius is the difference between a
	 * mis-edited row somebody notices at their leisure and an unmetered outbound dialer, which is
	 * exactly the reason `numbers.order` was carved out of `numbers.write` when the carrier
	 * integration landed. The same argument, one layer down.
	 *
	 * It is not a ride on `cdr.read` either, which is the other grant that touches calls. That one
	 * is a READ of what already happened, and `live-topics.ts` reasoned itself onto it for the live
	 * call feed on the grounds that "the same data, sooner" cannot be gated more loosely than "the
	 * same data, later". Origination is not the same data at all — it is a write, and the only
	 * write on this platform whose effect is audible in somebody's office.
	 *
	 * And it is exactly one. There is no `calls.hangup`, no `calls.transfer` and no `calls.monitor`,
	 * although all three are obvious neighbours: mid-call control is not exposed over HTTP at all
	 * today, and `live-topics.ts` already recorded that the live feed rides `cdr.read` until a
	 * wallboard role needs otherwise. Adding a permission for a surface that does not exist would
	 * be spending the ceiling on documentation.
	 *
	 * That last paragraph is now out of date in one place and deliberately left standing as the
	 * record: the surface arrived, and it brought `calls.control` with it. See below.
	 */
	"calls.originate",

	/**
	 * Taking control of a live call from outside the platform — the session protocol.
	 *
	 * The grant behind `GET /api/v1/session`: an external application opens a WebSocket, claims an
	 * `application` name for the organization, and from then on every call the dial plan routes to
	 * that name is handed to it — with the full verb surface, one command at a time, for as long as
	 * the call lasts. `calls.originate` above predicted a permission like this and declined to mint
	 * one on the grounds that "adding a permission for a surface that does not exist would be
	 * spending the ceiling on documentation". The surface exists now.
	 *
	 * It is NOT a ride on `calls.originate`, and the difference is the direction of the power.
	 * Origination makes one phone ring, once, and its blast radius is a trunk minute. This grant is
	 * standing authority over calls that have not happened yet: the holder can answer a customer's
	 * call, record it, dial a third party into it and hang it up, on every call for as long as the
	 * socket stays open. A click-to-dial button and a programmable call flow are not the same
	 * decision, and an administrator handing out the first should not silently be handing out the
	 * second.
	 *
	 * It is NOT a ride on `routes.write` either, which is the other grant that decides where calls
	 * go. That one is CONFIGURATION and it is where the `application` destination is created — but
	 * creating the destination is naming a hole in the dial plan, and this is the permission to
	 * stand in it. Two different people can reasonably hold those: the telephony administrator
	 * points a DID at `crm`, and the integration's API key is what may then be `crm`.
	 *
	 * And it is NOT `calls.supervise`, though the two are the only grants here that reach live
	 * audio. Supervision is a power over a call the holder was never part of, exercised silently,
	 * and the entry above says why that makes it manager-only. This one only ever receives calls the
	 * organization's own dial plan deliberately sent to it — a destination somebody configured, not
	 * an arbitrary conversation the holder chose. It is the difference between answering a phone and
	 * listening at a door.
	 *
	 * ONE entry, and the claim is inside it rather than beside it. A separate
	 * `applications.register` was drafted, so that "may connect" and "may claim the name `crm`"
	 * could be granted apart. It was dropped because there is nothing to do with the first without
	 * the second: a session socket that has claimed no application receives no calls and can send no
	 * verbs, so a grant for it would authorise an idle connection. The name a socket may claim is a
	 * question of WHICH application, not of whether — and if that ever needs bounding, the answer is
	 * a scoped variant here, not a second resource.
	 */
	"calls.control",

	/**
	 * Listening to a colleague's call while it is happening — `*0` supervision: monitor, whisper,
	 * barge.
	 *
	 * The second entry on `calls`, and the one with the largest blast radius in the whole registry.
	 * Every other grant here is a power over CONFIGURATION or over RECORDS. This one is a power over
	 * a **person**: the holder can put themselves inside a live conversation between a member of
	 * this organization and someone who has never heard of this platform, and neither of them is
	 * told. There is no other permission on this system that does that, which is the whole argument
	 * for its existence — a boundary no existing grant can express is exactly the test the ceiling's
	 * instruction asks for, and this is the clearest pass it has had.
	 *
	 * The two neighbours it is NOT, spelled out because both were drafted as the ride:
	 *
	 * It is not `queues.monitor`. That grant is a WALLBOARD: aggregate queue depth, agent states,
	 * how long the longest caller has waited — and it is deliberately an AGENT-level grant, because
	 * an agent who cannot see the queue they are working cannot do the job. It exposes counts about
	 * calls, never the audio inside one. Riding supervision on it would hand every agent in every
	 * tenant the ability to listen to every other agent, by way of a permission that was granted so
	 * a number could render on a screen. That is the single worst privilege escalation this
	 * registry could ship.
	 *
	 * It is not `recordings.listen` either, and the difference is not merely one of timing. A
	 * recording is an ARTEFACT: it exists, it has a row, it is announced by whatever the tenant's
	 * recording policy plays at the top of the call, and the person on the call can find out that it
	 * was made and ask for it. Supervision leaves the subject nothing to find. The only trace of it
	 * is the audit row this platform writes, which is why that row is not optional and why the
	 * description below says so where an administrator granting the permission will read it.
	 *
	 * **Manager and above, never agent.** Not because a supervisor is senior — supervising is what a
	 * team leader does all day, and a case could be made for an agent-level `calls.supervise.own`
	 * bounded to a queue's tiers. It is because of who has to be NAMEABLE afterwards. In a
	 * two-party-consent jurisdiction, silently listening to a call is a thing a specific identified
	 * human did, and the defence is the audit trail that identifies them. A grant held by the
	 * broadest role in an organization is a grant whose audit trail says "one of the forty people on
	 * the floor". Held by managers, it says a name. When the scoped variant lands it must carry the
	 * same property or it should not land.
	 *
	 * ONE entry, again. `calls.whisper` and `calls.barge` were drafted as separate grants on the
	 * argument that whispering and barging are louder than listening. They were dropped because the
	 * escalation between them is free: a monitor session is a media tap that is already attached, so
	 * anybody holding `calls.supervise` can move between the three modes by pressing a digit, and a
	 * permission a holder can escalate past by pressing `2` is a distinction a reviewer cannot act
	 * on. The consent boundary is crossed by the first one.
	 */
	"calls.supervise",

	// --- Media, reporting and audit -----------------------------------------
	"recordings.read",
	"recordings.read.own",
	"recordings.download",
	"recordings.delete",
	"recordings.configure",

	"cdr.read",
	"cdr.read.own",
	"cdr.export",

	/**
	 * Reading the `audit_log` change ledger.
	 *
	 * Its own entry rather than a ride on `settings.read`, which is what the ledger's writer said
	 * it was waiting for (`apps/api/src/pbx/shared/audit-log.service.ts`, "No read surface,
	 * deliberately"). The two are not the same question: `settings.read` is held by every
	 * self-service role in the registry — a user has it so their own preferences screen renders —
	 * and the ledger is a record of every change every OTHER member made, with the before/after
	 * of each one. Guarding it with `settings.read` would hand the organization's whole change
	 * history to the narrowest role there is.
	 *
	 * `read` and no more: the table is append-only in the database itself (the tenant role holds
	 * `SELECT, INSERT` under two policies rather than one `FOR ALL`), so there is no write, no
	 * delete and no retention knob for a permission to guard. If an export path lands later it
	 * gets `audit.export`, on the same argument that split `cdr.export` from `cdr.read`.
	 */
	"audit.read",

	/**
	 * The SIP edge's network policy: CIDR allow/deny entries, and the authentication-failure log.
	 *
	 * Its own resource rather than a ride on `settings.*`, on exactly the argument the audit entry
	 * above makes. `settings.read` is held by every self-service role so a user's preferences
	 * screen renders; `security.write` is the ability to open the platform's SIP surface to an
	 * arbitrary network, which is the same privilege class as issuing credentials and belongs
	 * nowhere near the narrowest role in the registry.
	 *
	 * TWO entries, and the count was fought for — the registry carries a size ceiling with an
	 * instruction attached ("prove the existing grants cannot express the boundary"), so here is the
	 * proof for two and the argument against the other two that were drafted.
	 *
	 * There is no `security.delete`. An ACL entry is a rule, not a record: removing one and
	 * disabling one are the same act with the same consequence, so a separate delete grant would be
	 * a distinction a reviewer cannot act on. That is the opposite of the entity resources, where a
	 * delete destroys history somebody may need.
	 *
	 * There is no separate grant for the attack log either, and that WAS drafted. The case for
	 * splitting it is that a stream of source addresses and attempted account names is a different
	 * kind of sensitive from a configuration table. The case against — which wins — is that it is
	 * not a different AUDIENCE or a different blast radius: the allowlist itself already discloses
	 * which networks reach this platform, the two are read by the same person answering the same
	 * question during the same incident, and a role that could see the refusals but not the rule
	 * that caused them would be a role that cannot finish the investigation. `security.read` covers
	 * both.
	 */
	"security.read",
	"security.write",

	/**
	 * Outbound webhook subscriptions — where this platform's events are delivered, and with what key.
	 *
	 * TWO entries, shaped exactly like `security.*` above and for the same reasons.
	 *
	 * Its own resource rather than a ride on `settings.*`, because `settings.write` is held by the
	 * roles that manage a tenant's ordinary configuration and this grant is the ability to point a
	 * copy of every call event in the organization at an arbitrary URL. That is an exfiltration
	 * primitive, not a preference, and it belongs in the same privilege class as opening the SIP
	 * surface to a network.
	 *
	 * There is no `webhooks.delete`. A subscription is a rule, not a record: deleting one and
	 * disabling one stop the same deliveries with the same consequence and leave nothing behind that
	 * anybody could need, so a separate delete grant would be a distinction a reviewer cannot act on.
	 * The identical argument `security.delete` lost.
	 *
	 * There is no `webhooks.deliveries.read` either, and it was drafted. There is no delivery LOG to
	 * read — the current health lives on the subscription row and comes back with
	 * `webhooks.read` — so the grant would guard a surface that does not exist. If a delivery-attempt
	 * table lands, its payloads are a tenant's own call data and the read that guards them is this
	 * one, unless somebody can show it is a different audience.
	 */
	"webhooks.read",
	"webhooks.write",

	/**
	 * White-label branding — the product name, logo, colours, support address and custom host a
	 * tenant (or a reseller, as the default its children inherit) presents to its users.
	 *
	 * ONE entry, and it is a write. Reading the EFFECTIVE branding is not a power worth its own
	 * grant: it is presentation configuration a preferences screen renders, so the authenticated
	 * read rides `settings.read` like the rest of the settings cascade, and the pre-auth theming
	 * read the web shell makes by request host is `@PublicRoute` — it returns only brand fields for
	 * one host and reaches no tenant data, so no permission gates it at all. What earns a named grant
	 * is CHANGING the brand: a custom domain and a logo are the tenant's identity to its own users,
	 * and pointing a host at this platform is closer to `webhooks.write` (an outward-facing surface)
	 * than to editing a preference. It rides its own resource for the same reason `security.*` and
	 * `webhooks.*` do — `settings.write` is held by the roles that manage ordinary configuration, and
	 * this is not that.
	 */
	"branding.write",

	// --- Platform and tenancy ------------------------------------------------
	"settings.read",
	"settings.write",
	/**
	 * The user's own preferences — the third level of the settings cascade, and the pair that had
	 * to exist before it could.
	 *
	 * `packages/pbx-db/src/schema/settings-schema.ts` dropped the `user_setting` table and named
	 * four prerequisites for bringing it back: a catalogue of which settings are user-scoped at
	 * all, this permission pair, a resolver, and a surface. These are the second of the four, and
	 * they are a pair rather than a ride on the unscoped grants for a reason that runs the opposite
	 * way to most `.own` entries in this registry.
	 *
	 * Elsewhere `.own` NARROWS a power an administrator also has: `extensions.read.own` is a slice
	 * of `extensions.read`, and a manager holding the unscoped grant can do everything the scoped
	 * one can. Here the unscoped grants are about a DIFFERENT ROW. `settings.write` edits the
	 * organization's answer, which applies to everyone; `settings.write.own` edits one person's
	 * override of it, which applies to nobody else. A manager who may set the tenant's default is
	 * not thereby entitled to reach into a colleague's preferences and change them, and
	 * `hasPermission`'s rule — an unscoped grant covers its scopes — would say they are.
	 *
	 * That is why the resolution of "own" is a ROW check in the service rather than a decorator
	 * argument, exactly as `queue-agent-session.service.ts` argues for `queues.join.own`: the
	 * decorator is an AND over a request and the rule here is about which row is being written.
	 * The endpoint declares this grant as its floor and then proves the row belongs to the caller.
	 *
	 * `settings.read` (unscoped) stays in `SELF_SERVICE_PERMISSIONS` and is not replaced by
	 * `settings.read.own`. Reading the organization's settings is how a preferences screen shows
	 * what it is overriding — "inherited: on" needs the inherited value — and hiding it would make
	 * a per-user override an unexplained toggle.
	 */
	"settings.read.own",
	"settings.write.own",
	"settings.write.all",

	"members.read",
	"members.invite",
	"members.update-role",
	"members.remove",

	"api-keys.read",
	"api-keys.read.own",
	"api-keys.write",
	"api-keys.write.own",
	"api-keys.revoke",

	"provisioning.read",
	"provisioning.write",
	"provisioning.tokens",

	/**
	 * The reseller (parent-tenant) surface — administering the child organizations under a reseller.
	 *
	 * TWO entries, and the count is defended the way this registry asks. `read` lists the children,
	 * their identity and their aggregate usage; `write` creates a child, suspends or reinstates one,
	 * and sets the reseller relationship. There is no `reseller.delete`: a child is an organization,
	 * and deleting one is `organization`-plugin territory guarded by better-auth's own `owner` gate,
	 * not a reseller power — suspension, not destruction, is what a parent tenant does.
	 *
	 * ## Why these are safe to hand the `admin` template, unlike a real platform-operator grant
	 *
	 * Holding `reseller.write` is INERT on an ordinary tenant. The reseller surface is gated twice:
	 * the endpoint requires this permission AND requires the session's own organization to carry the
	 * platform `is_reseller` flag (a control-plane fact set outside these five per-tenant templates,
	 * on the untenanted `organization_hierarchy` row). An admin of a normal organization holds the
	 * permission and reaches nothing, because their org is not a reseller. This is the distinction
	 * the `org-limits.write` note gestures at: the reseller hierarchy is the platform-operator home
	 * those quotas were waiting for, and the capability check — not a role template — is what makes it
	 * a real cross-tenant boundary. Row reach is then narrowed by `assertMayAct`: a reseller only ever
	 * touches children whose `parent_organization_id` is its own org, the same row check
	 * `queue-agent-session.service.ts` uses for `.own`.
	 */
	"reseller.read",
	"reseller.write",

	/**
	 * Configuring the organization's SSO identity providers — the per-org OIDC IdP an admin points
	 * their members' sign-in at.
	 *
	 * ONE entry, and it is `configure` rather than a read/write pair, because there is nothing to
	 * read that is not a secret: a provider row is an issuer, a client id and a client SECRET, and the
	 * secret never leaves the process. Listing which IdPs an org has configured, and creating,
	 * editing or removing one, are the same administrative act on the same sensitive rows, done by
	 * the same person — the split a read/write pair buys elsewhere (a wide reader, a narrow writer)
	 * has no audience here. It is its own resource rather than a ride on `settings.write` for the
	 * `security.*`/`webhooks.*` reason: pointing an organization's authentication at an external IdP
	 * is a credential-class power, not ordinary configuration.
	 */
	"sso.configure",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions that were declared, checked nothing, and have been removed.
 *
 * ## Why a list of things that are gone
 *
 * A permission the registry declares and no server ever checks is not neutral — it is a promise
 * the UI can render and the server cannot keep. The role editor shows it, an administrator grants
 * it believing it does something, and the endpoint it appears to describe either does not exist or
 * is guarded by a different grant entirely. The parity audit found a dozen of these and called
 * each one "a promise the UI can render and the server cannot keep", which is the right phrase for
 * it.
 *
 * The fix for each was one of two things: guard the endpoint that obviously corresponds, or delete
 * the entry. The ones below were deleted. This record exists so the deletion is a decision with a
 * reason attached rather than a diff somebody re-adds in six months — and so
 * `permissions.spec.ts` can assert that none of them has crept back into {@link PERMISSIONS}
 * without an endpoint arriving with it.
 *
 * **Re-adding one is allowed, and the bar is the same as for any new entry**: the endpoint lands
 * in the same change as the permission, with a `@RequirePermissions` on it. That is the rule the
 * header at the top of this file already states; these ten are simply the evidence for why it
 * matters.
 *
 * ## The four reasons, and which entries they cover
 *
 * **The subsystem was deleted.** `applications.*` and `secrets.*` guarded the legacy gRPC
 * platform's voice-application and secret-storage services. Both tables were dropped
 * (`apps/api/drizzle/20260806164427_drop_legacy_api_tables`), the services are gone, and
 * `apps/api/src/core/db/schema.ts` records the removal. Six entries guarding six absences.
 *
 * **The action has no transport.** `devices.reboot` describes "send a remote reboot or resync
 * request to a device" — a SIP `NOTIFY` with `Event: check-sync`. Nothing in this platform sends
 * one: `apps/sipd` is a registrar and answers `501` to everything else, and the engine's ARI path
 * has no out-of-dialog NOTIFY. `trunks.test` is the same shape one layer out — it described
 * forcing a re-registration or placing a diagnostic call, and there is no on-demand probe to
 * trigger. (Trunk health does now arrive, but it arrives from Asterisk's qualify pinger on its own
 * schedule, which is a fact that is reported rather than an action anybody performs.)
 *
 * **The surface is deliberately not HTTP.** This reason had exactly one entry —
 * `conferences.moderate` — and it is the one entry that has since come BACK, which is the record
 * this list exists to keep. It described mid-call control of a live room, was retired because no
 * such surface existed, and returned in the change that built one
 * (`conference-moderation.controller.ts`) with a `@RequirePermissions` on every route. That is the
 * bar the header states, met: the endpoint lands in the same commit as the permission.
 *
 * It is left described here rather than deleted because the ARGUMENT is what has value — a
 * permission with no endpoint is a promise the UI can render and the server cannot keep — and a
 * reason with no current members is evidence the rule works rather than a section to tidy away.
 *
 * **The thing it guards is code, not data.** `provisioning.templates` promised template CRUD.
 * Templates are compiled-in TypeScript modules (`apps/api/src/provisioning/catalog/templates/`),
 * reviewed and deployed like the rest of the source. There is no row to edit and no endpoint that
 * could exist without first making templates data.
 */
export const RETIRED_PERMISSIONS = [
	"applications.read",
	"applications.write",
	"applications.delete",
	"applications.deploy",
	"devices.reboot",
	"provisioning.templates",
	"secrets.read",
	"secrets.rotate",
	"trunks.test",
] as const;

export type RetiredPermission = (typeof RETIRED_PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
	return PERMISSION_SET.has(value);
}

export interface PermissionDescriptor {
	readonly permission: Permission;
	readonly label: string;
	readonly description: string;
}

export interface PermissionGroup {
	readonly resource: string;
	readonly label: string;
	readonly description: string;
	readonly permissions: readonly PermissionDescriptor[];
}

/**
 * Grouped, human-labelled view of {@link PERMISSIONS}. Drives the role editor UI and the
 * generated web-app contract. A spec asserts it covers every permission exactly once.
 */
export const PERMISSION_CATALOG: readonly PermissionGroup[] = [
	{
		resource: "extensions",
		label: "Extensions",
		description: "Internal endpoints, their dialling behaviour and their user assignment.",
		permissions: [
			{
				permission: "extensions.read",
				label: "View extensions",
				description: "List and inspect every extension in the organization.",
			},
			{
				permission: "extensions.read.own",
				label: "View own extension",
				description: "Inspect only the extensions assigned to the acting user.",
			},
			{
				permission: "extensions.write",
				label: "Manage extensions",
				description: "Create and edit any extension, including routing and voicemail options.",
			},
			{
				permission: "extensions.write.own",
				label: "Edit own extension",
				description: "Change forwarding, do-not-disturb and follow-me on own extensions.",
			},
			{
				permission: "extensions.delete",
				label: "Delete extensions",
				description: "Permanently remove an extension and detach its devices.",
			},
			{
				permission: "extensions.assign",
				label: "Assign extensions",
				description: "Bind an extension to a member or release it.",
			},
		],
	},
	{
		resource: "devices",
		label: "Devices",
		description: "Desk phones and softphones, their lines and their programmable keys.",
		permissions: [
			{
				permission: "devices.read",
				label: "View devices",
				description: "List every registered and provisioned device.",
			},
			{
				permission: "devices.read.own",
				label: "View own devices",
				description: "Inspect only devices bound to the acting user's extensions.",
			},
			{
				permission: "devices.write",
				label: "Manage devices",
				description: "Create and edit devices, lines and key layouts.",
			},
			{
				permission: "devices.delete",
				label: "Delete devices",
				description: "Remove a device and revoke its provisioning credentials.",
			},
		],
	},
	{
		resource: "numbers",
		label: "Numbers",
		description: "DIDs, their inbound treatment and their emergency dispatch location.",
		permissions: [
			{
				permission: "numbers.read",
				label: "View numbers",
				description: "List DIDs and their current routing.",
			},
			{
				permission: "numbers.write",
				label: "Manage numbers",
				description: "Create, edit and re-route DIDs, including caller-ID overrides.",
			},
			{
				permission: "numbers.order",
				label: "Order numbers",
				description:
					"Buy a new DID from the connected carrier. Creates a recurring charge on the organization's account.",
			},
			{
				permission: "numbers.delete",
				label: "Delete numbers",
				description:
					"Release a DID from the organization, and from the carrier when the platform ordered it.",
			},
			{
				permission: "numbers.assign",
				label: "Assign numbers",
				description: "Point a DID at an extension, ring group, IVR or queue.",
			},
			{
				permission: "numbers.emergency",
				label: "Manage emergency routing",
				description:
					"Set the dispatchable location and notification policy (Kari's Law / RAY BAUM'S).",
			},
		],
	},
	{
		resource: "trunks",
		label: "Trunks",
		description: "Carrier connections, registrations and their credentials.",
		permissions: [
			{
				permission: "trunks.read",
				label: "View trunks",
				description: "List carriers and their registration state.",
			},
			{
				permission: "trunks.write",
				label: "Manage trunks",
				description: "Create and edit carrier connections, codecs and channel caps.",
			},
			{
				permission: "trunks.delete",
				label: "Delete trunks",
				description: "Remove a carrier connection.",
			},
		],
	},
	{
		resource: "routes",
		label: "Routing",
		description: "Inbound and outbound routes, dial patterns, time conditions and feature codes.",
		permissions: [
			{
				permission: "routes.read",
				label: "View routing",
				description: "Inspect inbound and outbound routes and their conditions.",
			},
			{
				permission: "routes.write",
				label: "Manage routing",
				description: "Create and edit routes, dial patterns, toll classes and time conditions.",
			},
			{
				permission: "routes.delete",
				label: "Delete routes",
				description: "Remove a route from the routing model.",
			},
			{
				permission: "routes.publish",
				label: "Publish routing",
				description: "Compile the routing model and invalidate the runtime routing cache.",
			},
			{
				permission: "routes.simulate",
				label: "Simulate routing",
				description: "Trace how a number would be routed without placing a call.",
			},
		],
	},
	{
		resource: "time-conditions",
		label: "Time conditions",
		description: "Business-hours and holiday schedules, and the branches they gate.",
		permissions: [
			{
				permission: "time-conditions.read",
				label: "View time conditions",
				description: "Inspect schedules, their rules and where each branch goes.",
			},
			{
				permission: "time-conditions.write",
				label: "Manage time conditions",
				description: "Create and edit schedules, rules, timezones and no-match branches.",
			},
			{
				permission: "time-conditions.delete",
				label: "Delete time conditions",
				description: "Remove a schedule once no route gates on it.",
			},
		],
	},
	{
		resource: "feature-codes",
		label: "Feature codes",
		description: "The star-code catalogue dialled from a handset.",
		permissions: [
			{
				permission: "feature-codes.read",
				label: "View feature codes",
				description: "List the star codes and the action each one runs.",
			},
			{
				permission: "feature-codes.write",
				label: "Manage feature codes",
				description: "Create and edit star codes, their actions and their parameters.",
			},
			{
				permission: "feature-codes.delete",
				label: "Delete feature codes",
				description: "Remove a star code from the dial plan.",
			},
		],
	},
	{
		resource: "call-block",
		label: "Caller screening",
		description: "The allow and deny list every call is checked against before it is routed.",
		permissions: [
			{
				permission: "call-block.read",
				label: "View screening rules",
				description: "List the blocked and allowed numbers, and how often each rule has matched.",
			},
			{
				permission: "call-block.write",
				label: "Manage screening rules",
				description:
					"Block or allow a caller. An allow rule overrides a broader block, so this grant can also re-admit a number the organization had excluded.",
			},
			{
				permission: "call-block.delete",
				label: "Delete screening rules",
				description:
					"Remove a rule permanently, discarding its match history. Disabling a rule keeps both.",
			},
		],
	},
	{
		resource: "ivr",
		label: "IVR menus",
		description: "Auto-attendant menus, prompts and their nested options.",
		permissions: [
			{
				permission: "ivr.read",
				label: "View IVR menus",
				description: "Inspect menus, options and prompts.",
			},
			{
				permission: "ivr.write",
				label: "Manage IVR menus",
				description: "Create and edit menus, digit options and greetings.",
			},
			{
				permission: "ivr.delete",
				label: "Delete IVR menus",
				description: "Remove a menu and detach it from routes.",
			},
			{
				permission: "ivr.publish",
				label: "Publish IVR menus",
				description: "Compile menu changes into the runtime routing model.",
			},
		],
	},
	{
		resource: "ring-groups",
		label: "Ring groups",
		description: "Simultaneous, sequential and rollover hunt groups.",
		permissions: [
			{
				permission: "ring-groups.read",
				label: "View ring groups",
				description: "Inspect groups, members and strategies.",
			},
			{
				permission: "ring-groups.write",
				label: "Manage ring groups",
				description: "Create and edit groups, destinations, delays and timeout actions.",
			},
			{
				permission: "ring-groups.delete",
				label: "Delete ring groups",
				description: "Remove a ring group.",
			},
		],
	},
	{
		resource: "paging-groups",
		label: "Paging groups",
		description:
			"Overhead announcements and talkback intercom, and the handsets each group auto-answers on.",
		permissions: [
			{
				permission: "paging-groups.read",
				label: "View paging groups",
				description: "Inspect groups, their members and the fan-out order.",
			},
			{
				permission: "paging-groups.write",
				label: "Manage paging groups",
				description:
					"Create and edit groups, add and remove handsets, and switch a group between " +
					"one-way announcement and talkback.",
			},
			{
				permission: "paging-groups.delete",
				label: "Delete paging groups",
				description: "Remove a paging group.",
			},
		],
	},
	{
		resource: "shared-lines",
		label: "Shared lines",
		description:
			"Shared line appearances: one line that appears on several handsets at once, each on a " +
			"button of its own, seized and held as a single resource.",
		permissions: [
			{
				permission: "shared-lines.read",
				label: "View shared lines",
				description: "Inspect shared lines, their appearances and the button order.",
			},
			{
				permission: "shared-lines.write",
				label: "Manage shared lines",
				description:
					"Create and edit shared lines, add and remove appearances, and set the ring, " +
					"hold-recall and barge-in behaviour.",
			},
			{
				permission: "shared-lines.delete",
				label: "Delete shared lines",
				description: "Remove a shared line.",
			},
		],
	},
	{
		resource: "queues",
		label: "Queues",
		description: "Call queues, agents, tiers and live queue state.",
		permissions: [
			{
				permission: "queues.read",
				label: "View queues",
				description: "Inspect queues, strategies and tier configuration.",
			},
			{
				permission: "queues.write",
				label: "Manage queues",
				description: "Create and edit queues, announcements and overflow behaviour.",
			},
			{
				permission: "queues.delete",
				label: "Delete queues",
				description: "Remove a queue.",
			},
			{
				permission: "queues.manage-agents",
				label: "Manage agents",
				description: "Assign agents to tiers and force agent state changes.",
			},
			{
				permission: "queues.monitor",
				label: "Monitor queues",
				description: "Watch live queue and agent state on the wallboard.",
			},
			{
				permission: "queues.join",
				label: "Set agent availability",
				description: "Log any agent into or out of a queue.",
			},
			{
				permission: "queues.join.own",
				label: "Join and leave queues",
				description: "Set own agent availability in queues the user belongs to.",
			},
		],
	},
	{
		resource: "voicemail",
		label: "Voicemail",
		description: "Mailboxes, greetings, messages and message-waiting indication.",
		permissions: [
			{
				permission: "voicemail.read",
				label: "View mailboxes",
				description: "Inspect every mailbox and its configuration.",
			},
			{
				permission: "voicemail.read.own",
				label: "View own mailbox",
				description: "Inspect only mailboxes belonging to the acting user.",
			},
			{
				permission: "voicemail.write",
				label: "Manage mailboxes",
				description: "Create and edit mailboxes, greetings and delivery options.",
			},
			{
				permission: "voicemail.delete",
				label: "Delete messages",
				description: "Delete messages from any mailbox in the organization.",
			},
			{
				permission: "voicemail.delete.own",
				label: "Delete own messages",
				description: "Delete messages from own mailboxes.",
			},
			{
				permission: "voicemail.listen",
				label: "Listen to messages",
				description: "Play or download messages from any mailbox.",
			},
			{
				permission: "voicemail.listen.own",
				label: "Listen to own messages",
				description: "Play or download messages from own mailboxes.",
			},
		],
	},
	{
		resource: "conferences",
		label: "Conferences",
		description: "Conference rooms, PINs and in-conference moderation.",
		permissions: [
			{
				permission: "conferences.read",
				label: "View conferences",
				description: "Inspect rooms and their participants.",
			},
			{
				permission: "conferences.write",
				label: "Manage conferences",
				description: "Create and edit rooms, PINs and profiles.",
			},
			{
				permission: "conferences.delete",
				label: "Delete conferences",
				description: "Remove a conference room.",
			},
			{
				permission: "conferences.moderate",
				label: "Moderate live conferences",
				description:
					"Mute, deafen, remove or re-level a participant in a running meeting, and lock the room.",
			},
		],
	},
	{
		resource: "park-lots",
		label: "Park lots",
		description: "Call-park orbits, their slot ranges and their retrieval timeout.",
		permissions: [
			{
				permission: "park-lots.read",
				label: "View park lots",
				description: "Inspect park orbits and the slots they occupy.",
			},
			{
				permission: "park-lots.write",
				label: "Manage park lots",
				description: "Create and edit park orbits, slot ranges and timeout behaviour.",
			},
			{
				permission: "park-lots.delete",
				label: "Delete park lots",
				description: "Remove a park orbit.",
			},
		],
	},
	{
		resource: "faxes",
		label: "Fax",
		description:
			"Fax servers bound to a DID, their inbox and outbox, and the act of sending a fax out " +
			"through the carrier.",
		permissions: [
			{
				permission: "faxes.read",
				label: "View faxes",
				description: "List fax servers and the received/sent faxes in their inbox and outbox.",
			},
			{
				permission: "faxes.write",
				label: "Manage fax servers",
				description:
					"Create and edit fax servers: the DID they use, the header, fax-to-email and the retry policy.",
			},
			{
				permission: "faxes.delete",
				label: "Delete faxes",
				description: "Remove a fax server, or delete a fax from its inbox or outbox.",
			},
			{
				permission: "faxes.send",
				label: "Send faxes",
				description: "Queue an outbound fax for delivery through the carrier.",
			},
		],
	},
	{
		resource: "call-flows",
		label: "Call flows",
		description:
			"The day/night switch: where calls go in each mode, and who may move the switch. Also " +
			"gates the manual override on a time condition, which is the same act on a different table.",
		permissions: [
			{
				permission: "call-flows.read",
				label: "View call flows",
				description: "Inspect flows, their two destinations and which mode each is in.",
			},
			{
				permission: "call-flows.write",
				label: "Manage call flows",
				description:
					"Create and edit flows, their destinations, their number and their toggle code.",
			},
			{
				permission: "call-flows.delete",
				label: "Delete call flows",
				description: "Remove a call flow.",
			},
			{
				permission: "call-flows.toggle",
				label: "Switch between day and night",
				description:
					"Move a call flow between its day and night destinations, and force a time condition " +
					"open or closed. The receptionist's grant: it changes where calls go right now and " +
					"changes no configuration.",
			},
		],
	},
	{
		resource: "pin-sets",
		label: "Authorisation codes",
		description:
			"The PIN lists that gate expensive outbound routes. Codes are stored as digests and are " +
			"never readable; a call detail record names which code authorised a call, never the code.",
		permissions: [
			{
				permission: "pin-sets.read",
				label: "View authorisation codes",
				description:
					"Inspect PIN sets, their labels and which routes they gate. The codes themselves are " +
					"never returned.",
			},
			{
				permission: "pin-sets.write",
				label: "Manage authorisation codes",
				description:
					"Create and edit PIN sets, add and remove codes, and attach a set to an outbound route. " +
					"A holder can make an expensive route dialable by everybody in the building.",
			},
			{
				permission: "pin-sets.delete",
				label: "Delete authorisation codes",
				description: "Remove a PIN set, which removes the gate from every route that named it.",
			},
		],
	},
	{
		resource: "dial-plan",
		label: "Dial-plan building blocks",
		description:
			"Destination aliases, audio streams, organization speed dials and the dial-by-name " +
			"directory — the named things other routing points at.",
		permissions: [
			{
				permission: "dial-plan.read",
				label: "View dial-plan building blocks",
				description: "Inspect aliases, streams, speed dials and the directory.",
			},
			{
				permission: "dial-plan.write",
				label: "Manage dial-plan building blocks",
				description:
					"Create and edit aliases, streams, speed dials and directories. None of them reaches a " +
					"carrier except through the outbound routes every destination goes through.",
			},
			{
				permission: "dial-plan.delete",
				label: "Delete dial-plan building blocks",
				description: "Remove an alias, a stream, a speed dial or a directory.",
			},
		],
	},
	{
		resource: "org-limits",
		label: "Organization limits",
		description:
			"Per-organization quotas on extensions, trunks, simultaneous calls and stored audio, and " +
			"the usage measured against them.",
		permissions: [
			{
				permission: "org-limits.read",
				label: "View limits and usage",
				description:
					"See the organization's quotas and what it is using. A support tool: it is the answer " +
					'to "why did creating an extension fail".',
			},
			{
				permission: "org-limits.write",
				label: "Change limits",
				description:
					"Raise or lower the organization's own quotas. Held by the owner alone until the " +
					"reseller hierarchy gives this a platform-operator home.",
			},
		],
	},
	{
		resource: "calls",
		label: "Calls",
		description:
			"Placing calls from the platform, controlling them from an external application, and " +
			"listening in on calls already in progress.",
		permissions: [
			{
				permission: "calls.originate",
				label: "Place calls",
				description:
					"Ring an extension and connect it to a destination — the click-to-dial button. " +
					"Off-net destinations are billed to the organization.",
			},
			{
				permission: "calls.control",
				label: "Control calls programmatically",
				description:
					"Connect an external application to the session protocol and take control of every " +
					"call the dial plan routes to it — answering, playing audio, collecting digits, " +
					"recording, dialling and hanging up.",
			},
			{
				permission: "calls.supervise",
				label: "Monitor live calls",
				description:
					"Listen to a colleague's call in progress, whisper to them, or join the conversation. " +
					"Neither party is notified. Recorded on the audit trail every time it is used.",
			},
		],
	},
	{
		resource: "recordings",
		label: "Recordings",
		description: "Call recordings, their retention policy and their media.",
		permissions: [
			{
				permission: "recordings.read",
				label: "View recordings",
				description: "List recordings across the organization.",
			},
			{
				permission: "recordings.read.own",
				label: "View own recordings",
				description: "List only recordings of calls the acting user took part in.",
			},
			{
				permission: "recordings.download",
				label: "Download recordings",
				description: "Obtain a signed URL for recorded media.",
			},
			{
				permission: "recordings.delete",
				label: "Delete recordings",
				description: "Permanently remove recorded media.",
			},
			{
				permission: "recordings.configure",
				label: "Configure recording policy",
				description: "Set always-on, on-demand, pause-and-mask and retention rules.",
			},
		],
	},
	{
		resource: "cdr",
		label: "Call detail records",
		description: "Per-leg call history and reporting exports.",
		permissions: [
			{
				permission: "cdr.read",
				label: "View call history",
				description: "Search every call detail record in the organization.",
			},
			{
				permission: "cdr.read.own",
				label: "View own call history",
				description: "Search only records for calls the acting user took part in.",
			},
			{
				permission: "cdr.export",
				label: "Export call history",
				description: "Generate CSV or scheduled reporting exports.",
			},
		],
	},
	{
		resource: "audit",
		label: "Audit log",
		description: "The append-only record of who changed the phone system, and what they changed.",
		permissions: [
			{
				permission: "audit.read",
				label: "View the audit log",
				description:
					"Search the organization's change history and read the before/after of each change.",
			},
		],
	},
	{
		resource: "security",
		label: "Security",
		description:
			"Network access control for the SIP edge, and the record of failed authentication attempts.",
		permissions: [
			{
				permission: "security.read",
				label: "View network security",
				description:
					"Inspect the CIDR allow and deny entries that guard registration and trunks, and read " +
					"the log of refused authentication attempts.",
			},
			{
				permission: "security.write",
				label: "Manage network ACLs",
				description:
					"Create and edit CIDR rules. Opening a network here lets it reach the SIP authenticator.",
			},
		],
	},
	{
		resource: "webhooks",
		label: "Webhooks",
		description: "Where this organization's call events are delivered, and with what signing key.",
		permissions: [
			{
				permission: "webhooks.read",
				label: "View webhooks",
				description:
					"Inspect webhook endpoints, the events each one receives, and its delivery health. " +
					"Signing secrets are never returned.",
			},
			{
				permission: "webhooks.write",
				label: "Manage webhooks",
				description:
					"Create, edit and remove webhook endpoints, and rotate their signing secrets. An " +
					"endpoint receives a copy of every event it subscribes to.",
			},
		],
	},
	{
		resource: "branding",
		label: "Branding",
		description:
			"White-label appearance: product name, logo, colours, support address and custom domain.",
		permissions: [
			{
				permission: "branding.write",
				label: "Manage branding",
				description:
					"Set the organization's product name, logo, colours, support email and custom domain. " +
					"A reseller's own branding is the default its child organizations inherit.",
			},
		],
	},
	{
		resource: "reseller",
		label: "Reseller",
		description:
			"Administering the child organizations under a reseller: listing, provisioning, suspending " +
			"and aggregate usage. Active only for organizations the platform has flagged as resellers.",
		permissions: [
			{
				permission: "reseller.read",
				label: "View child organizations",
				description: "List the organizations under this reseller and their aggregate usage.",
			},
			{
				permission: "reseller.write",
				label: "Manage child organizations",
				description:
					"Create a child organization, suspend or reinstate one, and set the reseller relationship.",
			},
		],
	},
	{
		resource: "sso",
		label: "Single sign-on",
		description: "The organization's SSO identity providers and how members sign in through them.",
		permissions: [
			{
				permission: "sso.configure",
				label: "Configure SSO",
				description:
					"Add, edit and remove the organization's OIDC identity providers. Client secrets are " +
					"never returned.",
			},
		],
	},
	{
		resource: "settings",
		label: "Settings",
		description: "The organization settings cascade and platform defaults.",
		permissions: [
			{
				permission: "settings.read",
				label: "View settings",
				description: "Read organization settings and their effective values.",
			},
			{
				permission: "settings.write",
				label: "Manage settings",
				description: "Override organization-level settings.",
			},
			{
				permission: "settings.read.own",
				label: "View own preferences",
				description: "Read the acting user's own overrides of the organization's settings.",
			},
			{
				permission: "settings.write.own",
				label: "Edit own preferences",
				description:
					"Set or clear the acting user's own overrides. Only settings the catalogue marks user-scoped can be overridden, and only for the acting user.",
			},
			{
				permission: "settings.write.all",
				label: "Manage platform defaults",
				description: "Change defaults that apply to every organization. Platform operators only.",
			},
		],
	},
	{
		resource: "members",
		label: "Members",
		description: "Organization membership, invitations and role assignment.",
		permissions: [
			{
				permission: "members.read",
				label: "View members",
				description: "List members and pending invitations.",
			},
			{
				permission: "members.invite",
				label: "Invite members",
				description: "Send and resend organization invitations.",
			},
			{
				permission: "members.update-role",
				label: "Change member roles",
				description: "Move a member between roles.",
			},
			{
				permission: "members.remove",
				label: "Remove members",
				description: "Revoke a member's access to the organization.",
			},
		],
	},
	{
		resource: "api-keys",
		label: "API keys",
		description: "Programmatic credentials scoped to the organization.",
		permissions: [
			{
				permission: "api-keys.read",
				label: "View API keys",
				description: "List every API key issued for the organization.",
			},
			{
				permission: "api-keys.read.own",
				label: "View own API keys",
				description: "List only keys the acting user created.",
			},
			{
				permission: "api-keys.write",
				label: "Create API keys",
				description: "Issue keys with any permission subset the issuer holds.",
			},
			{
				permission: "api-keys.write.own",
				label: "Create own API keys",
				description: "Issue personal keys limited to the acting user's own permissions.",
			},
			{
				permission: "api-keys.revoke",
				label: "Revoke API keys",
				description: "Disable or delete an issued key.",
			},
		],
	},
	{
		resource: "provisioning",
		label: "Provisioning",
		description: "Device configuration templates and the authenticated provisioning endpoint.",
		permissions: [
			{
				permission: "provisioning.read",
				label: "View provisioning",
				description: "Inspect vendor catalogues and rendered device configuration.",
			},
			{
				permission: "provisioning.write",
				label: "Manage provisioning",
				description: "Edit provisioning settings and device profiles.",
			},
			{
				permission: "provisioning.tokens",
				label: "Manage provisioning tokens",
				description: "Issue and revoke the per-device tokens that authenticate config pulls.",
			},
		],
	},
];

/** Role templates seeded for every organization. Keys map to better-auth membership roles. */
export const SYSTEM_ROLE_IDS = ["owner", "admin", "manager", "user", "agent"] as const;
export type SystemRoleId = (typeof SYSTEM_ROLE_IDS)[number];

export interface SystemRoleTemplate {
	readonly id: SystemRoleId;
	readonly label: string;
	readonly description: string;
	/** The better-auth organization membership role this template is stored as. */
	readonly membershipRole: "owner" | "admin" | "member";
	readonly permissions: readonly Permission[];
}

const SELF_SERVICE_PERMISSIONS = [
	"extensions.read.own",
	"extensions.write.own",
	"devices.read.own",
	"voicemail.read.own",
	"voicemail.delete.own",
	"voicemail.listen.own",
	"recordings.read.own",
	"cdr.read.own",
	"api-keys.read.own",
	"api-keys.write.own",
	"settings.read",
	/**
	 * The narrowest role gets its own preferences, which is the point of the level existing.
	 *
	 * `settings.read` above it is the ORGANIZATION's answer and stays, because a preferences screen
	 * that cannot show what it is overriding turns "inherited" into an unexplained blank.
	 */
	"settings.read.own",
	"settings.write.own",
] as const satisfies readonly Permission[];

const AGENT_PERMISSIONS = [
	...SELF_SERVICE_PERMISSIONS,
	"queues.read",
	"queues.join.own",
	"queues.monitor",
	"conferences.read",
	// An agent parks calls with `*5`, so the lot list has to be readable to render where a call went.
	"park-lots.read",
	/**
	 * An agent pages with `*81`, so the group list has to be readable for the same reason the lot
	 * list is — with one difference worth stating, because it is the argument for reading and not
	 * for writing.
	 *
	 * A page is the loudest thing this platform does: it auto-answers every handset in the group and
	 * speaks into the room, whether or not anybody is standing there. The read grant is what turns
	 * "*81 then which digits?" into a list of names, and an agent who cannot see the list either
	 * memorises the numbers or pages the wrong floor — the failure mode is a warehouse hearing an
	 * announcement meant for the dispatch desk, not a missing screen. The WRITE grant is a different
	 * power entirely: it decides whose phone is in the group, which is to say whose desk can be
	 * spoken through, and that belongs with the manager who owns the floor plan. The same split as
	 * `park-lots`, for a feature where getting it wrong is audible.
	 */
	"paging-groups.read",
	/**
	 * Read, and NOT toggle — which is worth stating because the opposite is the obvious reading.
	 *
	 * A call flow exists so a human at the front desk can move it, and the front desk is an agent. So
	 * the tempting grant is `call-flows.toggle` here. It is not here for one structural reason: every
	 * other grant this role holds is `own`-scoped, read-only or a wallboard, and `permissions.spec.ts`
	 * asserts exactly that — the widest role an organization hands out does not get an org-wide write.
	 * A toggle IS an org-wide write: it re-points every inbound call in the tenant.
	 *
	 * The receptionist still gets the feature, from the place they actually use it. Pressing `*281` on
	 * a handset does not go through this registry at all — the engine trusts the authenticated
	 * extension, exactly as it does for `*72` and `*78`, because a handset carries no session. What an
	 * agent loses is the BUTTON in the admin UI, and the shape that would give it back is
	 * `call-flows.toggle.own` bounded to flows an extension is bound to. It is not in the registry
	 * because nothing serves it yet.
	 *
	 * `read` is here because a lamp on a phone and a list on a screen answer the same question, and an
	 * agent who cannot see which flow is in which mode cannot tell whether pressing the key worked.
	 */
	"call-flows.read",
] as const satisfies readonly Permission[];

const MANAGER_PERMISSIONS = [
	...AGENT_PERMISSIONS,
	"extensions.read",
	"extensions.write",
	"extensions.assign",
	"devices.read",
	"devices.write",
	"numbers.read",
	"numbers.assign",
	"routes.read",
	"routes.simulate",
	"time-conditions.read",
	"time-conditions.write",
	"feature-codes.read",
	"feature-codes.write",
	/**
	 * A manager maintains the screening list; an agent does not, and the delete stays with admins.
	 *
	 * The read/write pair is here because blocking a number is day-to-day work on a phone system —
	 * the same class of task as editing a ring group — and a manager who cannot do it has to raise a
	 * ticket to stop a robocaller. It is NOT in `AGENT_PERMISSIONS` despite the obvious pull of "the
	 * person who answered the phone should be able to block the caller", for the reason the registry
	 * entry gives: the same grant that writes a `block` rule writes an `allow` rule, and an allow
	 * rule lifts a number back out of a broader block. Handing the widest role in the organization
	 * the ability to quietly re-admit an excluded caller is the wrong side of that trade. An
	 * agent-level `call-block.write.own` bounded to inbound-and-block-only is the shape that would
	 * work, and it is not in the registry because nothing serves it yet.
	 *
	 * `call-block.delete` is absent for the ordinary reason every delete is absent from this list —
	 * and here it also destroys the `hitCount`/`lastHitAt` evidence, which is exactly what the
	 * registry entry split the grant to protect.
	 */
	"call-block.read",
	"call-block.write",
	"ivr.read",
	"ivr.write",
	"ivr.publish",
	"ring-groups.read",
	"ring-groups.write",
	// Read arrives with `AGENT_PERMISSIONS`; this is the half that edits the membership.
	"paging-groups.write",
	// Read arrives with `AGENT_PERMISSIONS`. `toggle` moves the switch and `write` re-points the
	// branches; both are org-wide writes, which is what keeps them at this level. See the note beside
	// `call-flows.read` in `AGENT_PERMISSIONS` for why the toggle is not one rung lower.
	"call-flows.toggle",
	"call-flows.write",
	/**
	 * The named building blocks, read and write.
	 *
	 * The same argument every other telephony CRUD grant on this list makes: a manager runs the phone
	 * system day to day, and "point the shop-radio stream at the after-hours branch" is that job. The
	 * delete stays with an administrator, like every other delete here.
	 */
	"dial-plan.read",
	"dial-plan.write",
	/**
	 * Read, and NOT write.
	 *
	 * A manager diagnosing "the phone is asking me for a number" needs to see that a route is gated
	 * and by which set. Adding a code to that set is a different act: it decides who may spend the
	 * tenant's money on an international minute, and it belongs with somebody who can be named when
	 * the bill arrives. The same split `numbers.order` made out of `numbers.write`.
	 */
	"pin-sets.read",
	/**
	 * The usage screen, which is a support tool: "you are at 48 of 50 extensions" is the answer to a
	 * ticket, and a manager who cannot see it experiences the limit as a create button that fails.
	 * `org-limits.write` is owner-only and is excluded from `ADMIN_PERMISSIONS` as well.
	 */
	"org-limits.read",
	"queues.write",
	"queues.manage-agents",
	"voicemail.read",
	"voicemail.write",
	"voicemail.listen",
	"conferences.write",
	/**
	 * A manager runs the meeting, which is why moderation sits beside `conferences.write` rather than
	 * with the admin block.
	 *
	 * It is a strictly SMALLER power than the write grant next to it — muting somebody for a minute
	 * against changing who may enter the room forever — so a role that may configure a room and not
	 * moderate one would be an odd shape. The AGENT role gets neither, for the reason it gets
	 * `conferences.read` and nothing else: an agent joins meetings and does not run them.
	 */
	"conferences.moderate",
	"park-lots.write",
	/**
	 * A manager runs the fax line day to day — configures it and sends from it — while the delete
	 * stays with an administrator, like every other telephony delete on this list. `faxes.read` and
	 * `faxes.write` are the configuration; `faxes.send` is the act of pushing a document out, which a
	 * manager does and an agent does not (there is no `own`-scoped fax, so it never reaches the
	 * self-service roles at all).
	 */
	"faxes.read",
	"faxes.write",
	"faxes.send",
	"recordings.read",
	"recordings.download",
	"cdr.read",
	"cdr.export",
	/**
	 * A manager may place a call, and an agent may not — which is the opposite of what a dial button
	 * in an agent console would want, and is deliberate until the scoped grant exists.
	 *
	 * The permission is organization-wide: it says "ring ANY extension in this tenant and connect it
	 * to a destination". For a manager that is the shape of the job. For an agent it would be the
	 * ability to make a colleague's phone ring and dial an international number from it, which is a
	 * strictly larger power than anything else in `AGENT_PERMISSIONS`, every one of which is scoped
	 * `own`. The right answer for an agent console is `calls.originate.own` — checked against
	 * `extension_user` — and it is not in the registry because nothing serves it yet.
	 */
	"calls.originate",
	/**
	 * A manager may listen to a live call, and an agent may not — and unlike `calls.originate`
	 * above, this one is not waiting for a scoped variant to soften it.
	 *
	 * The reason is in the entry itself: the defence for a silent monitor session is the audit row
	 * that names who opened it. `AGENT_PERMISSIONS` is the widest role an organization hands out, so
	 * granting it here would make that row say "somebody on the floor" — which is not a defence, it
	 * is a list of suspects. `queues.monitor` is a deliberate agent-level grant and reads adjacent
	 * on the wallboard; it is aggregate STATE and carries no audio, and the two must not be confused
	 * when somebody edits this list.
	 */
	"calls.supervise",
	/**
	 * `calls.control` is NOT here, and it is the one `calls.*` grant a manager does not get.
	 *
	 * Not because it is more dangerous than supervision — nothing in this registry is — but because
	 * it is a different KIND of decision. The two grants above are things a manager does to a call
	 * that is happening in front of them, on a screen, one at a time. This one connects a piece of
	 * software to the call path and leaves it there: every call the dial plan routes to that
	 * application, from the moment the socket opens until somebody notices it is still open. That
	 * is an integration, and choosing which software sits inside the phone system is an
	 * administrator's call in the same way choosing which trunk carries the traffic is.
	 *
	 * If a tenant wants their floor manager to run the CRM integration, a custom role grants it —
	 * which is exactly what custom roles are for, and is a decision with a name attached rather than
	 * a capability forty people inherited.
	 */
	"members.read",
	/**
	 * Device provisioning, minus the credential.
	 *
	 * A manager sets up desk phones — that is the job — so they need the vendor catalogue the device
	 * form renders from (`provisioning.read`) and the device profiles that decide what a phone's
	 * config actually says (`provisioning.write`). Both arrived here in the W7 permission pass, when
	 * the endpoints that serve them stopped being guarded by `devices.read`/`devices.write` and
	 * started being guarded by the permissions whose descriptions had named them all along.
	 *
	 * `provisioning.tokens` is deliberately NOT here, and it is the whole reason the resource is
	 * split three ways. A provisioning token is the secret a phone presents to fetch a configuration
	 * file containing its SIP password, and this role's own description says "No carrier, secret or
	 * provisioning-credential access". Before this pass the token endpoint rode `devices.write` and
	 * every manager held it, which made that sentence false.
	 */
	"provisioning.read",
	"provisioning.write",
] as const satisfies readonly Permission[];

/**
 * Everything except the two grants that are not an administrator's to hold.
 *
 * `settings.write.all` is the cross-organization platform scope and has always been the definition
 * of what `admin` does not get. `org-limits.write` joins it, and the reason is stated at its
 * registry entry: a quota an administrator can raise is not a quota. Neither is a real
 * control-plane boundary — an owner can still raise their own cap — but `owner` is the narrowest
 * boundary this model can express until the reseller hierarchy (W14) gives limits a
 * platform-operator home, and expressing it here is what makes that move a one-line change.
 */
const OWNER_ONLY_PERMISSIONS: ReadonlySet<string> = new Set<Permission>([
	"settings.write.all",
	"org-limits.write",
]);

const ADMIN_PERMISSIONS = PERMISSIONS.filter(
	(permission) => !OWNER_ONLY_PERMISSIONS.has(permission),
) as readonly Permission[];

export const SYSTEM_ROLE_TEMPLATES: readonly SystemRoleTemplate[] = [
	{
		id: "owner",
		label: "Owner",
		description:
			"Full control of the organization, including billing-adjacent settings and secrets. Cannot be removed by other members.",
		membershipRole: "owner",
		permissions: PERMISSIONS,
	},
	{
		id: "admin",
		label: "Administrator",
		description:
			"Full control of the organization's telephony, members and credentials. Cannot change platform-wide defaults.",
		membershipRole: "admin",
		permissions: ADMIN_PERMISSIONS,
	},
	{
		id: "manager",
		label: "Manager",
		description:
			"Runs the day-to-day phone system: extensions, devices, menus, groups, queues and reporting. No carrier, secret or provisioning-credential access.",
		membershipRole: "member",
		permissions: [...new Set(MANAGER_PERMISSIONS)],
	},
	{
		id: "agent",
		label: "Agent",
		description:
			"A queue agent: manages their own extension and voicemail and controls their own queue availability.",
		membershipRole: "member",
		permissions: [...new Set(AGENT_PERMISSIONS)],
	},
	{
		id: "user",
		label: "User",
		description: "An end user with access to their own extension, voicemail, devices and calls.",
		membershipRole: "member",
		permissions: [...SELF_SERVICE_PERMISSIONS],
	},
];

export function getSystemRoleTemplate(roleId: SystemRoleId): SystemRoleTemplate {
	const template = SYSTEM_ROLE_TEMPLATES.find((candidate) => candidate.id === roleId);
	if (!template) {
		throw new UnknownPermissionError(`Unknown system role template "${roleId}".`);
	}
	return template;
}

/** Raised when a permission or role identifier that is not in the registry is referenced. */
export class UnknownPermissionError extends Error {
	readonly _tag = "UnknownPermissionError" as const;

	constructor(message: string) {
		super(message);
		this.name = "UnknownPermissionError";
	}
}

export function parsePermission(value: string): {
	resource: string;
	action: string;
	scope?: PermissionScope;
} {
	if (!isPermission(value)) {
		throw new UnknownPermissionError(`"${value}" is not a registered permission.`);
	}
	const [resource, action, scope] = value.split(".") as [string, string, PermissionScope?];
	return scope === undefined ? { resource, action } : { resource, action, scope };
}

/**
 * Reshapes the flat registry into better-auth's access-control statement form
 * (`{ resource: ["action", "action.scope"] }`). Kept dependency-free so the registry can be
 * consumed by the web app codegen without pulling better-auth into the browser bundle.
 */
export function buildAccessControlStatements(
	permissions: readonly Permission[] = PERMISSIONS,
): Record<string, string[]> {
	const statements: Record<string, string[]> = {};
	for (const permission of permissions) {
		const [resource, ...rest] = permission.split(".");
		if (resource === undefined) continue;
		(statements[resource] ??= []).push(rest.join("."));
	}
	return statements;
}

/** True when `granted` satisfies `required`, treating an unscoped grant as covering its scopes. */
export function hasPermission(granted: Iterable<string>, required: Permission): boolean {
	const grantedSet = granted instanceof Set ? granted : new Set(granted);
	if (grantedSet.has(required)) {
		return true;
	}
	const { resource, action, scope } = parsePermission(required);
	return scope !== undefined && grantedSet.has(`${resource}.${action}`);
}
