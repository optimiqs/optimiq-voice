import { apiFetch } from "../api-client";
import type { ItemEnvelope } from "../pbx/contracts";

/**
 * `/api/v1/toll-fraud` — spend and velocity controls on international calling.
 *
 * ## Why this is not a `PBX_RESOURCES` descriptor
 *
 * The generic machinery in `lib/pbx/client.ts` is paged-list CRUD addressed by row id, and neither
 * half of this surface has that shape. The organization policy is a SINGLETON reached without an
 * id (the controller argues why, at length); the per-extension overrides are a collection keyed on
 * the EXTENSION id rather than on an id of their own, and they are written with `PUT` because an
 * override is a small complete statement rather than a row somebody patches a field of.
 *
 * ## The bodies are complete, so nothing here sends a diff
 *
 * `changedSettings` exists because the settings cascade PATCHes `{ name: value }` and an untouched
 * name must not be written. This surface is the opposite: `PUT` means the body IS the policy, and
 * omitting a ceiling REMOVES it. `changedPolicyKeys` in `./policy-form.ts` is therefore only ever
 * used to tell the user what they are about to change and to keep Save quiet — never to build a
 * body.
 *
 * Shapes are restated rather than imported, on the same terms as `lib/pbx/contracts.ts`: importing
 * the server's types would drag `zod/v4`, `@nestjs/common` and `@optimiq-voice/pbx-db` into the
 * browser bundle. Mirrors `apps/api/src/pbx/toll-fraud/toll-fraud.service.ts` and
 * `toll-fraud.dto.ts`; `Date` fields arrive as ISO strings.
 */

/** Mirrors `TollFraudPolicyRow`. `null` on a ceiling means unlimited on that axis. */
export interface TollFraudPolicy {
	readonly id: string;
	readonly organizationId: string;
	readonly enabled: boolean;
	readonly maxConcurrentInternationalCalls: number | null;
	readonly maxInternationalMinutesPerHour: number | null;
	readonly maxInternationalMinutesPerDay: number | null;
	readonly allowedCountries: readonly string[] | null;
	readonly deniedCountries: readonly string[] | null;
	readonly holdFirstCallToNewCountry: boolean;
	readonly offHoursInternationalLock: boolean;
	readonly offHoursStartMinute: number;
	readonly offHoursEndMinute: number;
	readonly offHoursTimezone: string | null;
	readonly autoSuspendOnSignal: boolean;
}

/**
 * Mirrors `writeTollFraudPolicyDto`.
 *
 * `null` means "no ceiling" here and NOT "inherit" — there is nothing above an organization to
 * inherit from. The override body one block down reads the opposite way, which is the asymmetry
 * the DTO's own comment calls out.
 */
export interface WriteTollFraudPolicy {
	readonly enabled: boolean;
	readonly maxConcurrentInternationalCalls: number | null;
	readonly maxInternationalMinutesPerHour: number | null;
	readonly maxInternationalMinutesPerDay: number | null;
	readonly allowedCountries: readonly string[] | null;
	readonly deniedCountries: readonly string[] | null;
	readonly holdFirstCallToNewCountry: boolean;
	readonly offHoursInternationalLock: boolean;
	readonly offHoursStartMinute: number;
	readonly offHoursEndMinute: number;
	readonly offHoursTimezone: string | null;
	readonly autoSuspendOnSignal: boolean;
}

/** Mirrors `OverrideRow`. Every configurable field is `null` when this extension inherits it. */
export interface ExtensionTollFraudOverride {
	readonly id: string;
	readonly organizationId: string;
	readonly extensionId: string;
	readonly enabled: boolean | null;
	readonly maxConcurrentInternationalCalls: number | null;
	readonly maxInternationalMinutesPerHour: number | null;
	readonly maxInternationalMinutesPerDay: number | null;
	readonly allowedCountries: readonly string[] | null;
	readonly deniedCountries: readonly string[] | null;
	readonly holdFirstCallToNewCountry: boolean | null;
	readonly offHoursInternationalLock: boolean | null;
	readonly outboundSuspended: boolean;
	readonly suspendedReason: string | null;
	readonly suspendedAt: string | null;
}

/** Mirrors `writeExtensionTollFraudOverrideDto`. `null` means INHERIT; `0` means "none at all". */
export interface WriteExtensionTollFraudOverride {
	readonly enabled: boolean | null;
	readonly maxConcurrentInternationalCalls: number | null;
	readonly maxInternationalMinutesPerHour: number | null;
	readonly maxInternationalMinutesPerDay: number | null;
	readonly allowedCountries: readonly string[] | null;
	readonly deniedCountries: readonly string[] | null;
	readonly holdFirstCallToNewCountry: boolean | null;
	readonly offHoursInternationalLock: boolean | null;
}

/** Mirrors `TollFraudUsage`. */
export interface TollFraudUsage {
	readonly concurrentInternationalCalls: number;
	readonly maxConcurrentInternationalCalls: number | null;
	readonly internationalMinutesLastHour: number;
	readonly maxInternationalMinutesPerHour: number | null;
	readonly internationalMinutesLastDay: number;
	readonly maxInternationalMinutesPerDay: number | null;
	readonly countriesSeen: readonly string[];
	/**
	 * How the concurrency figure was arrived at. `"gauge"` is the only value, and the screen says
	 * so in words: it is legs this platform saw answer minus legs it saw end, not a channel census.
	 */
	readonly concurrentMeasuredFrom: "gauge";
	readonly at: string;
}

/** `null` when the organization has no policy row — which means unconstrained, not "off". */
export async function fetchTollFraudPolicy(): Promise<TollFraudPolicy | null> {
	const { data } = await apiFetch<ItemEnvelope<TollFraudPolicy | null>>("/toll-fraud/policy");
	return data;
}

export async function writeTollFraudPolicy(body: WriteTollFraudPolicy): Promise<TollFraudPolicy> {
	const { data } = await apiFetch<ItemEnvelope<TollFraudPolicy>>("/toll-fraud/policy", {
		method: "PUT",
		body: JSON.stringify(body),
	});
	return data;
}

export async function fetchTollFraudUsage(): Promise<TollFraudUsage> {
	const { data } = await apiFetch<ItemEnvelope<TollFraudUsage>>("/toll-fraud/usage");
	return data;
}

export async function fetchTollFraudOverrides(): Promise<readonly ExtensionTollFraudOverride[]> {
	const { data } = await apiFetch<{ data: ExtensionTollFraudOverride[] }>("/toll-fraud/overrides");
	return data;
}

export async function writeTollFraudOverride(
	extensionId: string,
	body: WriteExtensionTollFraudOverride,
): Promise<ExtensionTollFraudOverride> {
	const { data } = await apiFetch<ItemEnvelope<ExtensionTollFraudOverride>>(
		`/toll-fraud/overrides/${encodeURIComponent(extensionId)}`,
		{ method: "PUT", body: JSON.stringify(body) },
	);
	return data;
}

/**
 * Suspend or restore one extension's outbound calling.
 *
 * Its own endpoint rather than a field on the override body, and the reason survives the trip to
 * the browser: restoring a phone must not require resending every ceiling that phone happens to
 * have, because the person doing it is doing it at speed.
 */
export async function suspendExtensionOutbound(
	extensionId: string,
	body: { readonly suspended: boolean; readonly reason?: string },
): Promise<ExtensionTollFraudOverride> {
	const { data } = await apiFetch<ItemEnvelope<ExtensionTollFraudOverride>>(
		`/toll-fraud/overrides/${encodeURIComponent(extensionId)}/suspension`,
		{ method: "PUT", body: JSON.stringify(body) },
	);
	return data;
}
