import { apiFetch } from "../api-client";
import type { ItemEnvelope, MutationEnvelope, PhoneNumberRow, TrunkRow } from "../pbx/contracts";

/**
 * The carrier surface — buying numbers, and provisioning a trunk at the carrier.
 *
 * ## The browser never sees a carrier field name
 *
 * `apps/api` reshapes the carrier's payloads into the platform's own vocabulary before they leave
 * the server, and these types mirror that shape rather than Telnyx's. That is deliberate and it is
 * the frontend's half of decision D5: the trunk model stays carrier-agnostic, so the moment this
 * file renders `cost_information.monthly_cost`, changing carrier becomes a frontend rewrite. The
 * only Telnyx-specific string in the whole app is the word "Telnyx" in a label.
 */

/** Matches the API's own ceiling in `carrier.dto.ts`. Asking for more is a 400. */
export const MAX_NUMBER_SEARCH_LIMIT = 50;
export const DEFAULT_NUMBER_SEARCH_LIMIT = 10;

export interface AvailableNumber {
	readonly e164: string;
	readonly region: string | null;
	readonly monthlyCost: string | null;
	readonly upfrontCost: string | null;
	readonly currency: string | null;
	readonly features: readonly string[];
	readonly reservable: boolean;
}

export interface CarrierStatus {
	readonly configured: boolean;
	readonly provider: string;
	readonly webhooksConfigured: boolean;
	readonly sipDomain: string;
}

export interface NumberSearchQuery {
	readonly country: string;
	readonly areaCode?: string | undefined;
	readonly contains?: string | undefined;
	readonly numberType?: string | undefined;
	readonly limit?: number | undefined;
}

/** What provisioning hands back, once. See the panel for why the password is shown exactly once. */
export interface TrunkCredentials {
	readonly sipDomain: string;
	readonly sipProxy: string;
	readonly sipUsername: string;
	readonly sipPassword: string;
	readonly sipUri: string;
	readonly registerExpiresSeconds: number;
	readonly connectionId: string;
	readonly outboundVoiceProfileId: string;
	readonly reprovisioned: boolean;
}

/**
 * Omits everything the caller did not set.
 *
 * The same reasoning as the CDR client's: the parameter object doubles as the React Query cache
 * key, so "no area code" and "area code is the empty string" have to collapse to one entry — and
 * an empty `areaCode=` would be a 400 from a DTO that validates digits, not a wider search.
 */
function searchParams(query: Record<string, unknown>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}
		params.set(key, String(value));
	}
	return params.toString();
}

export async function fetchCarrierStatus(): Promise<CarrierStatus> {
	const { data } = await apiFetch<ItemEnvelope<CarrierStatus>>("/carrier/status");
	return data;
}

export async function searchAvailableNumbers(
	query: NumberSearchQuery,
): Promise<{ readonly data: readonly AvailableNumber[]; readonly total: number }> {
	const serialized = searchParams({ ...query });
	return await apiFetch<{ data: AvailableNumber[]; total: number }>(
		`/carrier/available-numbers${serialized.length === 0 ? "" : `?${serialized}`}`,
	);
}

export interface OrderNumberBody {
	readonly e164: string;
	readonly label?: string | null;
	readonly destinationType: string;
	readonly destinationRef?: string | null;
	readonly destinationData?: unknown;
	readonly trunkId?: string;
}

export async function orderNumber(
	body: OrderNumberBody,
): Promise<MutationEnvelope<PhoneNumberRow>> {
	return await apiFetch<MutationEnvelope<PhoneNumberRow>>("/carrier/number-orders", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

/**
 * Delete AND release.
 *
 * A different endpoint from the plain `DELETE /phone-numbers/:id`, because the two are different
 * operations: this one gives the number back to the carrier and stops the bill, the other only
 * removes it from the organization. The Numbers screen chooses between them based on whether the
 * row is carrier-managed, which is why `PhoneNumberRow.carrierProvider` exists on the wire.
 */
export async function releaseNumber(
	phoneNumberId: string,
): Promise<MutationEnvelope<{ readonly id: string }>> {
	return await apiFetch<MutationEnvelope<{ id: string }>>(
		`/carrier/numbers/${encodeURIComponent(phoneNumberId)}`,
		{ method: "DELETE" },
	);
}

export interface ProvisionTrunkBody {
	readonly concurrentCallLimit?: number;
	readonly dailySpendLimit?: string;
}

export async function provisionTrunk(
	trunkId: string,
	body: ProvisionTrunkBody = {},
): Promise<MutationEnvelope<TrunkRow> & { readonly carrier: TrunkCredentials }> {
	return await apiFetch<MutationEnvelope<TrunkRow> & { carrier: TrunkCredentials }>(
		`/trunks/${encodeURIComponent(trunkId)}/provision-telnyx`,
		{ method: "POST", body: JSON.stringify(body) },
	);
}
