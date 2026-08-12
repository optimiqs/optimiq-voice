import { ConflictException, HttpStatus } from "@nestjs/common";

/**
 * Organization quotas — upstream's "domain limits", which the inventory names as the seam that
 * becomes SaaS metering.
 *
 * # What is enforced where, and why the two are different in kind
 *
 * `maxExtensions` and `maxTrunks` are enforced at CREATE, in the same transaction as the insert.
 * There is a row to refuse and a person on the other end of the refusal, so the answer is a 4xx
 * naming the limit and the current count — which is a sentence somebody can act on ("you are at 50
 * of 50; disable one or ask for more").
 *
 * `maxConcurrentCalls` cannot be. There is no row to refuse: there is a CALL to refuse, and refusing
 * it late is a caller hearing congestion rather than an administrator seeing an error message.
 *
 * That sentence used to describe an intention. It now describes a mechanism, and the mechanism is
 * worth naming here because it is nowhere near this file: the column is folded into the routing
 * snapshot's `settings` by `snapshot-loader.ts`, compiled onto
 * `CompiledRoutingSettings.maxConcurrentCalls`, and enforced by the engine's channel orchestrator at
 * StasisStart admission — before the KV claim, before `channel.created`, and with
 * `SWITCH_CONGESTION`, which is the same cause the per-trunk ceiling
 * (`TrunkAttempt.maxChannels`) refuses with. Different scope, same mechanism.
 *
 * The one thing this endpoint therefore CANNOT do is report the usage: the count lives in the
 * engines, per replica, and is not a thing the control plane can ask for on a page load. See
 * {@link OrgUsageEntry.measured}.
 *
 * `maxStorageMb` is enforced at upload for the same reason the counts are: there is a request to
 * refuse.
 *
 * # NULL is unlimited, and that is load-bearing
 *
 * This table arrives after tenants exist. A column with a number in it — or a row that had to be
 * created before a tenant could be used — would silently cap every organization already running. So
 * every column is nullable, an absent ROW is an empty set of limits, and creating the row is what
 * starts the metering rather than what the metering depends on.
 */

/** The limits an organization is subject to. Every field absent means "no limit". */
export interface OrgLimits {
	readonly maxExtensions?: number | null;
	readonly maxTrunks?: number | null;
	readonly maxConcurrentCalls?: number | null;
	readonly maxStorageMb?: number | null;
}

/** Which limit a refusal names. The wire value, so a client can switch on it. */
export const ORG_LIMIT_NAMES = [
	"maxExtensions",
	"maxTrunks",
	"maxConcurrentCalls",
	"maxStorageMb",
] as const;

export type OrgLimitName = (typeof ORG_LIMIT_NAMES)[number];

/** The human name of each limit, for the message a person reads. */
const LIMIT_LABELS: Readonly<Record<OrgLimitName, string>> = {
	maxExtensions: "extensions",
	maxTrunks: "trunks",
	maxConcurrentCalls: "simultaneous calls",
	maxStorageMb: "megabytes of stored audio",
};

/**
 * Raised when a create would exceed a quota.
 *
 * A 409 rather than a 403: the request is well-formed and the caller is entitled to make it, and
 * what refuses it is the state of the ORGANIZATION rather than the caller's permissions. That
 * distinction matters to a client — a 409 is retried after freeing something and a 403 is not — and
 * it matches what `PBX_REFERENCED` already means on this surface.
 *
 * A Nest exception rather than one of `pbx.errors.ts`'s Effect failures, because the check happens
 * one layer ABOVE the repository: it is a read-then-create, not part of the write transaction. See
 * `OrgLimitsService.assertMayCreate` for what that costs and why it is the right trade.
 *
 * The body names the limit, the ceiling and the current count, because "limit reached" with no
 * numbers is a message a support engineer has to go and look up.
 */
export function orgLimitExceeded(
	limit: OrgLimitName,
	ceiling: number,
	current: number,
): ConflictException {
	return new ConflictException({
		statusCode: HttpStatus.CONFLICT,
		code: "PBX_LIMIT_REACHED",
		message: `This organization is limited to ${String(ceiling)} ${LIMIT_LABELS[limit]} and already has ${String(current)}.`,
		limit,
		ceiling,
		current,
	});
}

/** What the usage endpoint answers with: one line per limit, whether or not a ceiling is set. */
export interface OrgUsageEntry {
	readonly limit: OrgLimitName;
	readonly used: number;
	/** `null` means no ceiling — the tenant is unlimited on this axis. */
	readonly ceiling: number | null;
	/** `null` when there is no ceiling. A fraction rather than a percentage, so a UI decides. */
	readonly ratio: number | null;
	/**
	 * Whether `used` is a MEASUREMENT or a placeholder.
	 *
	 * Three of the four limits are counted with a `select count(*)` in this process and are true at
	 * the instant they were read. `maxConcurrentCalls` is not: simultaneous calls are live state the
	 * engines hold, and the control plane has no way to ask that does not involve enumerating every
	 * live leg on the platform on every page load. So its `used` is zero, and this flag is what stops
	 * a screen from rendering that zero as "nobody is on a call right now" — which is a different and
	 * much more confident statement than "this number is not measured here".
	 *
	 * The CEILING is real either way, and it is the fact an administrator came to this page for. It
	 * is also, as of the admission gate, actually enforced — see `org-limits.ts`'s header.
	 */
	readonly measured: boolean;
}

export interface OrgUsageReport {
	readonly entries: readonly OrgUsageEntry[];
	/**
	 * Bytes of stored audio, exact, before the megabyte rounding `maxStorageMb` compares against.
	 *
	 * Reported alongside the rounded figure because the rounding always goes the tenant's way — the
	 * comparison divides rather than multiplying, so a tenant is never refused for a fraction of a
	 * megabyte — and a support engineer looking at "48 of 50" needs to be able to see whether that is
	 * 48.0 or 48.9.
	 */
	readonly storageBytes: number;
}

/**
 * Builds one usage line, with the ratio only where a ceiling exists to divide by.
 *
 * `measured` defaults to true because three of the four limits are counted, and the one that is not
 * says so at its call site rather than every other one saying that it is. A line that is not
 * measured also reports no RATIO: dividing a placeholder by a real ceiling produces a percentage
 * that looks like a measurement, which is the exact confusion the flag exists to prevent.
 */
export function usageEntry(
	limit: OrgLimitName,
	used: number,
	ceiling: number | null | undefined,
	measured = true,
): OrgUsageEntry {
	const bound = ceiling ?? null;
	return {
		limit,
		used,
		ceiling: bound,
		ratio: bound === null || bound === 0 || !measured ? null : used / bound,
		measured,
	};
}

/**
 * Refuses a create that would exceed a ceiling.
 *
 * `current` is the count BEFORE the insert, so the test is `>=` rather than `>`: at 50 of 50 the
 * next one would be the 51st.
 */
export function assertWithinLimit(
	limit: OrgLimitName,
	ceiling: number | null | undefined,
	current: number,
): void {
	if (ceiling === null || ceiling === undefined) {
		return;
	}
	if (current >= ceiling) {
		throw orgLimitExceeded(limit, ceiling, current);
	}
}
