import { hasAnyPermission, hasEveryPermission } from "./permissions";
import { routes } from "./routes";
import type { Permission } from "./permissions";

/**
 * Route → permission map. The one place a page's access requirement is written down.
 *
 * The sidebar does not carry permissions on its nav items and the route guard does not repeat
 * them either — both resolve through `getPagePermissions(path)`. That is the whole point: a nav
 * entry that is visible and a page that 403s cannot disagree, because there is only one answer.
 *
 * `mode: "any"` (the default) means the caller needs at least one of the listed permissions —
 * `cdr.read` OR `cdr.read.own` both justify reaching call history; they just show different rows.
 * `mode: "every"` is for surfaces that genuinely need a combination.
 *
 * A route absent from this map requires only a session. `[param]` segments match any value.
 */

export interface PageRequirement {
	readonly permissions: readonly Permission[];
	readonly mode?: "any" | "every";
}

export const PAGE_PERMISSIONS: Readonly<Record<string, PageRequirement>> = {
	[routes.extensions]: { permissions: ["extensions.read", "extensions.read.own"] },
	[routes.devices]: { permissions: ["devices.read", "devices.read.own"] },
	[routes.numbers]: { permissions: ["numbers.read"] },
	[routes.trunks]: { permissions: ["trunks.read"] },
	/**
	 * Four tabs share this page — inbound, outbound, time conditions, feature codes — and the last
	 * two now have permissions of their own rather than borrowing `routes.*`. `mode: "any"` is what
	 * keeps the page reachable for a role granted only one of them; the tab whose list the caller
	 * cannot read is the API's answer, not this map's.
	 */
	[routes.routing]: {
		permissions: ["routes.read", "time-conditions.read", "feature-codes.read"],
	},
	/**
	 * Call flows — the day/night switch.
	 *
	 * `call-flows.read` alone, which is what `CallFlowsController` guards its list and its get with.
	 * Toggling is `call-flows.toggle` and is gated INSIDE the page with `usePermission` rather than
	 * here, and that split is the feature rather than the usual read/write hedge: the receptionist
	 * template holds `read` and `toggle` and neither `write` nor `delete`, so this page has to open
	 * for somebody who can move the switch and cannot re-point either branch.
	 */
	[routes.callFlows]: { permissions: ["call-flows.read"] },
	/**
	 * Outbound authorisation codes.
	 *
	 * `pin-sets.read` is a real grant despite there being no secret to read: the digests never leave
	 * the server process, so what a reader sees is which routes are gated and by whose codes — which
	 * is exactly what somebody diagnosing "why is this phone asking me for a number" needs. A code's
	 * detail page inherits this by ancestry.
	 */
	[routes.pinSets]: { permissions: ["pin-sets.read"] },
	/**
	 * The four dial-plan building blocks.
	 *
	 * One entry for four tabs, because the API guards all four collections with the same
	 * `dial-plan.read`. Number translations are NOT on this page — they ride `routes.*` and live on
	 * `/routing` — precisely so this entry can name one permission and mean it.
	 */
	[routes.dialPlan]: { permissions: ["dial-plan.read"] },
	[routes.ivr]: { permissions: ["ivr.read"] },
	[routes.ringGroups]: { permissions: ["ring-groups.read"] },
	/**
	 * `paging-groups.read`, which is what `PagingGroupsController` guards both the group list and its
	 * nested `/members` with. NOT `ring-groups.read`, even though the two screens are siblings: a
	 * role granted one and not the other would otherwise see a nav entry the API refuses.
	 *
	 * A group's detail view inherits this by ancestry, because `/paging-groups/<id>` is nested under
	 * the list's path.
	 */
	[routes.pagingGroups]: { permissions: ["paging-groups.read"] },
	[routes.queues]: { permissions: ["queues.read"] },
	/**
	 * Caller screening.
	 *
	 * `call-block.read` alone, which is what `CallBlockController` guards its list and its get with.
	 * There is no `.own` variant and there should not be: a screening list is one organization-wide
	 * table, not a per-person one, and "the rules I wrote" is a question the audit log answers.
	 *
	 * Writing is `call-block.write` and deleting is `call-block.delete`; both are gated inside the
	 * page with `usePermission` rather than here, because a role that can SEE which numbers are
	 * screened and not change them is a real role — an operator reading the call history needs the
	 * blocklist beside it to make sense of a call that never arrived.
	 */
	[routes.callBlock]: { permissions: ["call-block.read"] },
	[routes.voicemail]: { permissions: ["voicemail.read", "voicemail.read.own"] },
	[routes.conferences]: { permissions: ["conferences.read"] },
	/**
	 * `park-lots.read` and nothing else — the `agent` template holds it precisely so a person who
	 * parks calls with `*5` can see which orbit a call landed in. Gating this page on `park-lots.write`
	 * would hide the lot list from everyone whose job is to use it.
	 */
	[routes.parkLots]: { permissions: ["park-lots.read"] },
	[routes.recordings]: { permissions: ["recordings.read", "recordings.read.own"] },
	/**
	 * The media library — hold music and the prompt library.
	 *
	 * `settings.read` because the API guards it with `settings.read`/`settings.write`, and it does
	 * that because there is no `media.*` pair in the registry and the registry is at its documented
	 * ceiling. Naming a different permission here would produce the exact disagreement this map
	 * exists to prevent: a visible nav entry and a page that 403s.
	 */
	[routes.mediaLibrary]: { permissions: ["settings.read"] },
	[routes.cdr]: { permissions: ["cdr.read", "cdr.read.own"] },
	/**
	 * The wallboard and, by ancestry, each queue's operator panel.
	 *
	 * `queues.monitor` alone, which is what BOTH halves of the screen are guarded with on the server:
	 * `live-topics.ts` gates the `queue:<id>` and `agent-state` topics on it, and the cdr controller
	 * gates `GET /cdr/queue-stats` on it too — deliberately, so a wallboard whose live tiles worked
	 * while its service-level row said 403 cannot happen.
	 *
	 * NOT `queues.read`, even though the page lists queues by name. The two grants come apart in the
	 * direction that matters: `queues.monitor` is what the `agent` template holds, and an agent
	 * watching their own queue is the whole point. Naming `cdr.read` would be worse still — it would
	 * hand a supervisor's SLA row the right to read every call the tenant ever made.
	 *
	 * Acting on what the panel shows — moving an agent in or out — is `queues.manage-agents` and is
	 * gated INSIDE the page, because a role that may watch the floor and not change it is a real role
	 * and is most of the people who will open this.
	 */
	[routes.wallboard]: { permissions: ["queues.monitor"] },
	/**
	 * The change ledger.
	 *
	 * `audit.read` alone, and that single entry is the whole reason the permission exists:
	 * `AuditLogController` argues that guarding the change history of every resource with
	 * `settings.read` would have put it behind the narrowest role in the registry — every
	 * self-service role holds `settings.read` so a preferences screen renders. There is no `.own`
	 * variant to fall back to, because "the changes I made" is not a question the ledger is indexed
	 * to answer cheaply; the `actorUserId` filter is how somebody asks it.
	 */
	[routes.auditLog]: { permissions: ["audit.read"] },
	/**
	 * SIP security — the network allowlist and the refusals it produced.
	 *
	 * `security.read`, which is what both `SipAclEntriesController` and `SipAuthEventController`
	 * guard their reads with. Writing is `security.write` and is gated inside the page with
	 * `usePermission`, not here: a role that can see which networks are allowed but not change them
	 * should SEE them — an operator reading the attack log needs the rule list next to it to make
	 * sense of an `acl-denied` row.
	 */
	[routes.security]: { permissions: ["security.read"] },
	/**
	 * Outbound webhook subscriptions.
	 *
	 * `webhooks.read`, which is what `WebhooksController` guards `GET` with. Creating, editing and
	 * DELETING all ride `webhooks.write` — there is no `webhooks.delete` in the registry, on the
	 * controller's own argument that deleting a subscription and disabling it stop the same
	 * deliveries.
	 */
	[routes.webhooks]: { permissions: ["webhooks.read"] },
	[routes.settings]: { permissions: ["settings.read"] },
	[routes.members]: { permissions: ["members.read"] },
	[routes.apiKeys]: { permissions: ["api-keys.read", "api-keys.read.own"] },
	/**
	 * Dispatchable locations.
	 *
	 * Declared explicitly rather than left to inherit `/settings`' `settings.read`, which would be
	 * the wrong answer in both directions: an admin with `numbers.read` and no settings grant could
	 * not reach the addresses their DIDs point at, and one with `settings.read` and no numbers grant
	 * could. The API guards reads with `numbers.read`, so this says the same thing.
	 */
	[routes.emergencyAddresses]: { permissions: ["numbers.read"] },
	/**
	 * The notification settings.
	 *
	 * `settings.read` because that is exactly what `OrgSettingsController` guards the category read
	 * with. Naming anything else here would produce the disagreement this map exists to prevent —
	 * a visible nav tab and a page that 403s. Saving needs `settings.write`, which the page gates
	 * with `RequirePermission` rather than with a route requirement: a role that can see the
	 * organization's policy but not change it should see it, read-only, not be told the page does
	 * not exist.
	 */
	[routes.notifications]: { permissions: ["settings.read"] },
	/**
	 * The routing settings.
	 *
	 * `settings.read`, not `routes.read`, for the reason the route itself lives under `/settings`:
	 * `OrgSettingsController` guards `GET …/categories/:category` with `settings.read` and `PATCH`
	 * with `settings.write`, and this map's whole job is to say what the API says. A caller with
	 * `routes.read` and no settings grant can edit inbound routes all day and still cannot read this
	 * category — naming `routes.read` here would show them a tab that 403s.
	 *
	 * Declared explicitly rather than inherited from `/settings`, which resolves to the same
	 * requirement today: an inherited answer would silently follow `/settings` if that ever changed,
	 * and these are the settings a live call is compiled from.
	 */
	[routes.routingSettings]: { permissions: ["settings.read"] },
	/**
	 * The recording retention policy.
	 *
	 * `settings.read`, because that is what the category READ is guarded with. It is deliberately
	 * not `recordings.configure`, even though that is the grant the save needs: `CATEGORY_PERMISSIONS`
	 * on the server puts the override on the WRITE alone, on the argument that the retention window
	 * is not itself sensitive and a settings screen that cannot show the current window cannot
	 * explain what `recordings.configure` would change. So the page opens for anyone who can read
	 * settings and renders read-only without the narrower grant.
	 */
	[routes.recordingSettings]: { permissions: ["settings.read"] },
	/**
	 * The organization's quotas and what it is using against them.
	 *
	 * `org-limits.read` and NOT `settings.read`, which is the widest divergence between a permission
	 * and its neighbours anywhere in the settings area — and it is the API's. `OrgLimitsController`
	 * makes the read deliberately wide because the usage screen is a SUPPORT tool ("you are at 48 of
	 * 50 extensions" is the answer to a ticket), and makes the write `owner`-only because a quota an
	 * administrator can raise is not a quota.
	 *
	 * Naming `settings.read` here would show the tab to every self-service role — all of them hold it
	 * so a preferences screen renders — and 403 them. The write grant is gated inside the page, so a
	 * manager who can read the ceilings sees them read-only rather than being told the page does not
	 * exist.
	 */
	[routes.limits]: { permissions: ["org-limits.read"] },
	/**
	 * The caller's own preferences.
	 *
	 * `settings.read.own`, which is exactly what `GET /org-settings/me` is guarded with, and the
	 * only entry in this map that names a `.own` grant on its own.
	 *
	 * It reads like the tightest entry here and is in fact the loosest, because of which way
	 * `hasPermission` substitutes: an UNSCOPED grant covers its scopes, so everyone holding
	 * `settings.read` reaches this page as well, while a scoped grant never covers the unscoped
	 * requirement — so naming `settings.read` here would shut out a role that holds only the
	 * personal one, on the one page in this area that is about them.
	 *
	 * Saving needs `settings.write.own` and is gated inside the page, not here: a role that may see
	 * what is in force for it and not change it should see it.
	 */
	[routes.mySettings]: { permissions: ["settings.read.own"] },
};

/** True when `path` matches `pattern`, treating any `[segment]` in the pattern as a wildcard. */
export function matchesPathPattern(path: string, pattern: string): boolean {
	if (path === pattern) {
		return true;
	}
	if (!pattern.includes("[")) {
		return false;
	}
	const pathParts = path.split("/").filter(Boolean);
	const patternParts = pattern.split("/").filter(Boolean);
	if (pathParts.length !== patternParts.length) {
		return false;
	}
	return patternParts.every(
		(part, index) => (part.startsWith("[") && part.endsWith("]")) || part === pathParts[index],
	);
}

/**
 * The requirement for a path, walking up to the nearest declared ancestor.
 *
 * `/settings/members/pending` inherits `/settings/members` — a nested view can never be less
 * protected than the page it lives under, which is the failure mode an exact-match-only lookup
 * quietly allows.
 */
export function getPagePermissions(path: string): PageRequirement | undefined {
	const normalized = path.replace(/\/+$/u, "") || "/";

	const exact = Object.entries(PAGE_PERMISSIONS).find(([pattern]) =>
		matchesPathPattern(normalized, pattern),
	);
	if (exact) {
		return exact[1];
	}

	const ancestors = Object.entries(PAGE_PERMISSIONS)
		.filter(([pattern]) => normalized.startsWith(`${pattern}/`))
		.sort(([a], [b]) => b.length - a.length);

	return ancestors[0]?.[1];
}

export function canAccessPage(path: string, granted: Iterable<string>): boolean {
	const requirement = getPagePermissions(path);
	if (!requirement) {
		return true;
	}
	return requirement.mode === "every"
		? hasEveryPermission(granted, requirement.permissions)
		: hasAnyPermission(granted, requirement.permissions);
}
