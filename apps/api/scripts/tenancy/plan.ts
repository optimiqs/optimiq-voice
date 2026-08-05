/**
 * Identity-removal **Step 5 item 1** — the rules that decide which organization owns a telephony
 * row. I/O-free on purpose: `apps/api/test/tenancy/tenancyBackfillPlan.test.ts` drives every
 * branch without a database, exactly as `identity-migration/plan.ts` does for Step 2.
 *
 * The adapter that reads the ledger and writes the rows is
 * `apps/api/scripts/backfill-tenancy-organization-id.ts`.
 */

/** A legacy workspace access key. `WO` is hardcoded across the identity era; see plan §2.10. */
const LEGACY_WORKSPACE_ACCESS_KEY_PATTERN = /^WO[0-9A-Za-z]+$/u;

/** RFC 4122 textual form, which is what `organization.id` (uuid v7) serialises to. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isLegacyWorkspaceAccessKey(value: string): boolean {
	return LEGACY_WORKSPACE_ACCESS_KEY_PATTERN.test(value);
}

export function isUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}

/**
 * The tables this backfill owns, in dependency order.
 *
 * `applications` and `secrets` carry the tenant themselves (`access_key_id`). The three service
 * tables do not — they hang off an application by `application_ref` — so they inherit the
 * organization their parent resolved to, which is why they come second.
 */
export const TENANT_SOURCE_TABLES = ["applications", "secrets"] as const;
export const TENANT_DERIVED_TABLES = [
	"tts_services",
	"stt_services",
	"intelligence_services",
] as const;
export const TENANT_TABLES = [...TENANT_SOURCE_TABLES, ...TENANT_DERIVED_TABLES] as const;

export type TenantSourceTable = (typeof TENANT_SOURCE_TABLES)[number];
export type TenantDerivedTable = (typeof TENANT_DERIVED_TABLES)[number];
export type TenantTable = (typeof TENANT_TABLES)[number];

/** What `resolveOrganizationId` concluded about one row's `access_key_id`. */
export type AccessKeyResolution =
	/** The ledger has a `WO…` → organization row. The normal case for pre-cutover data. */
	| { readonly kind: "mapped"; readonly organizationId: string }
	/**
	 * The column already holds an organization id. Rows written after the cutover do this: the
	 * runtime has no `WO…` key to put there and `access_key_id` is still `not null`, so it stores
	 * the organization id in both columns. Same precedent as the per-call token's `accessKeyId`
	 * claim (Step 4).
	 */
	| { readonly kind: "self"; readonly organizationId: string }
	/** Blank / whitespace. Cannot be attributed to anyone; reported, never guessed. */
	| { readonly kind: "blank" }
	/** A `WO…` key with no ledger row, or something that is neither. Blocks finalisation. */
	| { readonly kind: "unmapped"; readonly accessKeyId: string };

export interface TenantLedger {
	/** `WO…` → `organization.id`, from `legacy_workspace_organization`. */
	readonly byAccessKey: ReadonlyMap<string, string>;
	/** Every known `organization.id`, so a self-referencing value can be validated. */
	readonly organizationIds: ReadonlySet<string>;
}

/**
 * Decides the organization for one `access_key_id` value.
 *
 * Deliberately total and deliberately conservative: there is no fallback that invents a tenant.
 * A row this cannot attribute stays NULL and is counted, and `SET NOT NULL` refuses to run while
 * any such row exists — sequencing rule 2, "a bad backfill is recoverable rather than a lockout".
 */
export function resolveOrganizationId(
	accessKeyId: string | null | undefined,
	ledger: TenantLedger,
): AccessKeyResolution {
	const value = (accessKeyId ?? "").trim();
	if (value.length === 0) {
		return { kind: "blank" };
	}

	const mapped = ledger.byAccessKey.get(value);
	if (mapped !== undefined) {
		return { kind: "mapped", organizationId: mapped };
	}

	if (isUuid(value)) {
		const normalized = value.toLowerCase();
		if (ledger.organizationIds.has(normalized)) {
			return { kind: "self", organizationId: normalized };
		}
	}

	return { kind: "unmapped", accessKeyId: value };
}

export interface TenantRowCounts {
	/** Rows already carrying an organization id — a rerun sees these and writes nothing. */
	readonly alreadyScoped: number;
	/** Rows this pass would set (or did set). */
	readonly mapped: number;
	/** Rows whose `access_key_id` already was an organization id. */
	readonly selfMapped: number;
	/** Rows with a blank `access_key_id`. */
	readonly blank: number;
	/** Rows whose `access_key_id` resolves to nothing. */
	readonly unmapped: number;
}

export function emptyTenantRowCounts(): TenantRowCounts {
	return { alreadyScoped: 0, mapped: 0, selfMapped: 0, blank: 0, unmapped: 0 };
}

export function addResolution(counts: TenantRowCounts, resolution: AccessKeyResolution) {
	switch (resolution.kind) {
		case "mapped":
			return { ...counts, mapped: counts.mapped + 1 };
		case "self":
			return { ...counts, selfMapped: counts.selfMapped + 1 };
		case "blank":
			return { ...counts, blank: counts.blank + 1 };
		default:
			return { ...counts, unmapped: counts.unmapped + 1 };
	}
}

/** Rows that would still be NULL after this pass — the only thing that blocks `SET NOT NULL`. */
export function unresolvedRowCount(counts: TenantRowCounts): number {
	return counts.blank + counts.unmapped;
}

/** Raised when the backfill cannot proceed. Mirrors `IdentityMigrationError` from Step 2. */
export class TenancyBackfillError extends Error {
	readonly _tag = "TenancyBackfillError" as const;

	constructor(message: string) {
		super(message);
		this.name = "TenancyBackfillError";
	}
}

/**
 * The guard `--finalize` runs before it may apply `SET NOT NULL`.
 *
 * Returns the human-readable reasons finalisation is refused; an empty array means it is safe.
 */
export function findFinalizationBlockers(
	perTable: ReadonlyMap<string, TenantRowCounts>,
): readonly string[] {
	const blockers: string[] = [];
	for (const table of TENANT_TABLES) {
		const counts = perTable.get(table);
		if (!counts) {
			blockers.push(`${table}: not inspected`);
			continue;
		}
		if (counts.blank > 0) {
			blockers.push(`${table}: ${String(counts.blank)} row(s) have a blank access_key_id`);
		}
		if (counts.unmapped > 0) {
			blockers.push(
				`${table}: ${String(counts.unmapped)} row(s) have an access_key_id that maps to no organization`,
			);
		}
	}
	return blockers;
}
