/**
 * Emergency dialing — the one routing decision that is not the tenant's to make.
 *
 * # Why this is a table in a compiler rather than a route an admin creates
 *
 * Kari's Law (47 U.S.C. §623) requires that a multi-line telephone system place a `911` call
 * **with no prefix and no permission**, from any station, and that it notify a central location
 * when one is placed. RAY BAUM'S Act §506 adds that the call must carry a *dispatchable location*.
 * Neither is expressible as an `OutboundRule`: every field on one is a gate (`enabled`,
 * `tollClass`, the time condition, the call-block table), and a compliance requirement that a
 * tenant can switch off by unticking a box is not a compliance requirement.
 *
 * So the emergency table is compiled from a fixed seed list plus whatever the organization adds,
 * it is written into BOTH the internal and outbound match tables, and both resolvers consult it
 * **before** anything that could refuse a call. The bypass list is exactly:
 *
 * | gate                              | normally             | emergency |
 * | --------------------------------- | -------------------- | --------- |
 * | `OutboundMatchTable.enabled`      | refuses every call   | ignored   |
 * | the caller's toll class           | refuses the route    | ignored   |
 * | `callBlock` (outbound + both)     | refuses the number   | ignored   |
 * | the route's time condition        | closes after hours   | absent    |
 * | `trunk.enabled`                   | drops the trunk      | ignored   |
 * | "the caller is not an extension"  | refuses outbound     | ignored   |
 *
 * # The seed list is deliberately short
 *
 * An emergency number shadows an internal one — the resolvers check this table first, on purpose —
 * so every entry is a number an extension may no longer be reachable at. `112` and `999` are real
 * emergency numbers in most of the world and *also* entirely plausible extension numbers in a
 * three-digit NANP dial plan, and a compiler that silently stole them would break dialing for
 * tenants who never asked for them. The seeds are therefore the NANP set only, and everything else
 * is `settings.emergencyNumbers` — one row, per organization, with a `emergency-number-shadowed`
 * warning if it collides with something.
 *
 * `933` is in the seeds because it is the carrier-provided E911 **test** number: it reads back the
 * ANI and the address the PSAP would see, and it is the only way an admin can check the
 * configuration without dialing an actual dispatcher.
 *
 * `9911` is in the seeds for the oldest reason in the field: users trained to dial `9` for an
 * outside line dial `9` before `911` under stress. It maps to the wire number `911`.
 */

import type { HangupCause } from "@optimiq-voice/telephony";

/** One entry of the emergency table: what the caller dials, and what goes on the wire. */
export interface EmergencyNumberSeed {
	/** The dialed string, matched exactly against the caller's digits. */
	readonly dialed: string;
	/** What the trunk is asked to dial. Differs from `dialed` for the `9`-prefixed forms. */
	readonly number: string;
}

/**
 * The compiled-in table. NANP only — see the header for why the list is not longer.
 *
 * Order is irrelevant (the compiler keys a record by `dialed`) but is kept stable so the artifact
 * is byte-identical across compiles.
 */
export const DEFAULT_EMERGENCY_NUMBERS: readonly EmergencyNumberSeed[] = [
	{ dialed: "911", number: "911" },
	{ dialed: "933", number: "933" },
	{ dialed: "9911", number: "911" },
	{ dialed: "9933", number: "933" },
	{ dialed: "+1911", number: "911" },
] as const;

/** How many organization-supplied emergency numbers are accepted. A bound, not a policy. */
export const MAX_EMERGENCY_NUMBERS = 32;

/** Dial strings are digits, `*`, `#` and a leading `+` — the same alphabet a dial plan speaks. */
const EMERGENCY_NUMBER_PATTERN = /^\+?[0-9*#]{2,16}$/;

export function isEmergencyDialString(value: string): boolean {
	return EMERGENCY_NUMBER_PATTERN.test(value);
}

/**
 * The seeds plus the organization's own, deduplicated by `dialed`, sorted.
 *
 * Additive rather than replacing: a tenant in Germany needs `112` **as well as** `911`, because a
 * handset provisioned by a US-based admin and a handset provisioned locally sit on the same PBX.
 * A configured entry dials itself — there is no place to express "dial 112, send 110" and no
 * demand for one; the `9`-prefixed forms that need it are seeds.
 *
 * Malformed entries are dropped rather than raising here: this function is also called by the
 * resolver's own consistency checks, and the compiler reports them with a subject and a path.
 */
export function emergencyNumbers(configured?: readonly string[]): readonly EmergencyNumberSeed[] {
	const byDialed = new Map<string, EmergencyNumberSeed>();
	for (const seed of DEFAULT_EMERGENCY_NUMBERS) {
		byDialed.set(seed.dialed, seed);
	}
	for (const raw of (configured ?? []).slice(0, MAX_EMERGENCY_NUMBERS)) {
		const dialed = raw.trim();
		if (!isEmergencyDialString(dialed) || byDialed.has(dialed)) {
			continue;
		}
		byDialed.set(dialed, { dialed, number: dialed });
	}
	return [...byDialed.values()].sort((left, right) =>
		left.dialed < right.dialed ? -1 : left.dialed > right.dialed ? 1 : 0,
	);
}

/** Configured entries this package refuses, so the compiler can name them in a diagnostic. */
export function invalidEmergencyNumbers(configured?: readonly string[]): readonly string[] {
	return (configured ?? []).filter((raw) => !isEmergencyDialString(raw.trim()));
}

/**
 * What lets an emergency dial continue to the next trunk.
 *
 * Deliberately much wider than `RETRYABLE_HANGUP_CAUSES`. That list exists to stop a compromised
 * extension from multiplying one fraudulent attempt by the number of carriers a tenant has, and
 * every cause it excludes is excluded because it represents a DECISION by the far end
 * (`CALL_REJECTED`, `USER_BUSY`, `NO_ANSWER`). For an emergency call the decision to reject is
 * precisely the reason to try the next carrier, and the fraud argument does not apply: the
 * destination is `911`, the amplification is four attempts, and the alternative is a call to a
 * dispatcher that stopped at the first carrier having a bad afternoon.
 *
 * `NORMAL_CLEARING` and `ORIGINATOR_CANCEL` stay out: those are the caller hanging up.
 */
export const EMERGENCY_CONTINUE_ON_CAUSES: readonly HangupCause[] = [
	"CALL_REJECTED",
	"CHANNEL_UNACCEPTABLE",
	"DESTINATION_OUT_OF_ORDER",
	"EXCHANGE_ROUTING_ERROR",
	"FACILITY_REJECTED",
	"GATEWAY_DOWN",
	"INCOMPATIBLE_DESTINATION",
	"INVALID_GATEWAY",
	"INVALID_NUMBER_FORMAT",
	"MEDIA_TIMEOUT",
	"NETWORK_OUT_OF_ORDER",
	"NORMAL_CIRCUIT_CONGESTION",
	"NORMAL_TEMPORARY_FAILURE",
	"NORMAL_UNSPECIFIED",
	"NO_ANSWER",
	"NO_ROUTE_DESTINATION",
	"NO_ROUTE_TRANSIT_NET",
	"NO_USER_RESPONSE",
	"OUTGOING_CALL_BARRED",
	"PROGRESS_TIMEOUT",
	"PROTOCOL_ERROR",
	"RECOVERY_ON_TIMER_EXPIRE",
	"REQUESTED_CHAN_UNAVAIL",
	"SERVICE_UNAVAILABLE",
	"SRTP_READ_ERROR",
	"SWITCH_CONGESTION",
	"UNALLOCATED_NUMBER",
	"USER_BUSY",
	"USER_NOT_REGISTERED",
] as const satisfies readonly HangupCause[];

/** The single plan-node id every emergency rule points at. */
export const EMERGENCY_NODE_ID = "trunk-dial:emergency";

/** The `outboundRouteId` an emergency dial node carries. Not a row id — there is no row. */
export const EMERGENCY_ROUTE_ID = "emergency";
