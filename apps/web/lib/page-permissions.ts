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
	[routes.ivr]: { permissions: ["ivr.read"] },
	[routes.ringGroups]: { permissions: ["ring-groups.read"] },
	[routes.queues]: { permissions: ["queues.read"] },
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
