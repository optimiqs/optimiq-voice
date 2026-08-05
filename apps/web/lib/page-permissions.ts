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
	[routes.routing]: { permissions: ["routes.read"] },
	[routes.ivr]: { permissions: ["ivr.read"] },
	[routes.ringGroups]: { permissions: ["ring-groups.read"] },
	[routes.queues]: { permissions: ["queues.read"] },
	[routes.voicemail]: { permissions: ["voicemail.read", "voicemail.read.own"] },
	[routes.conferences]: { permissions: ["conferences.read"] },
	[routes.recordings]: { permissions: ["recordings.read", "recordings.read.own"] },
	[routes.cdr]: { permissions: ["cdr.read", "cdr.read.own"] },
	[routes.settings]: { permissions: ["settings.read"] },
	[routes.members]: { permissions: ["members.read"] },
	[routes.apiKeys]: { permissions: ["api-keys.read", "api-keys.read.own"] },
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
