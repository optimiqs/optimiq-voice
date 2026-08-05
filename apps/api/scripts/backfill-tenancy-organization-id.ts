/**
 * Identity-removal **Step 5 item 1** — backfill `organization_id` on the `apps/api` telephony
 * tables from the Step 2 mapping ledger.
 *
 *   # rehearse (writes nothing: the transaction is rolled back at the end)
 *   pnpm --filter @optimiq-voice/api backfill:tenancy -- --dry-run
 *
 *   # run it
 *   pnpm --filter @optimiq-voice/api backfill:tenancy
 *
 *   # run it and, if every row resolved, apply the NOT NULL constraint
 *   pnpm --filter @optimiq-voice/api backfill:tenancy -- --finalize
 *
 *   # synthetic telephony rows keyed by the ledger's WO… keys, for a machine with an empty api DB
 *   pnpm --filter @optimiq-voice/api backfill:tenancy -- --seed-fixtures
 *   pnpm --filter @optimiq-voice/api backfill:tenancy -- --drop-fixtures
 *
 * Environment (all optional, all defaulted for the local docker stack):
 *
 *   API_DATABASE_URL   the telephony database being rewritten, default …:5433/optimiq-voice
 *   DATABASE_URL       the base database holding the ledger,      default …:5433/optimiq
 *
 * ## Why this is a script and not a migration
 *
 * The mapping lives in a **different database** (`legacy_workspace_organization` in the base
 * database that better-auth owns). A drizzle migration for `apps/api` has exactly one connection
 * and no way to reach it, so the join has to happen in application code that holds both.
 *
 * ## Properties (the same contract Step 2's migration established)
 *
 * - **Transactional.** One transaction against the telephony database. `--dry-run` is the same
 *   code path with a forced rollback, so a rehearsal hits every constraint the real run will.
 * - **Rerunnable.** Only rows with `organization_id is null` are considered, so a second run
 *   reports `alreadyScoped` and writes nothing.
 * - **Never guesses.** A row whose `access_key_id` resolves to no organization stays NULL, is
 *   counted, and is printed. `--finalize` refuses to run while any such row exists — that is
 *   sequencing rule 2 ("a bad backfill is recoverable rather than a lockout") made mechanical.
 * - **Additive.** `access_key_id` is left exactly as it was. It is dropped in Step 9, together
 *   with the ledger that is the sole record of which `WO…` key became which organization.
 */

import postgres from "postgres";
import {
	addResolution,
	emptyTenantRowCounts,
	findFinalizationBlockers,
	resolveOrganizationId,
	TENANT_DERIVED_TABLES,
	TENANT_SOURCE_TABLES,
	TENANT_TABLES,
	TenancyBackfillError,
	type TenantDerivedTable,
	type TenantLedger,
	type TenantRowCounts,
	type TenantSourceTable,
	unresolvedRowCount,
} from "./tenancy/plan";
import type { Sql, TransactionSql } from "postgres";

const DEFAULT_TELEPHONY_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq-voice";
const DEFAULT_BASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";

/** Marks synthetic rows written by `--seed-fixtures` so `--drop-fixtures` can find them again. */
const FIXTURE_TAG = "tenancy-backfill-fixture";

interface Options {
	readonly dryRun: boolean;
	readonly finalize: boolean;
	readonly seedFixtures: boolean;
	readonly dropFixtures: boolean;
	readonly telephonyUrl: string;
	readonly baseUrl: string;
	readonly json: boolean;
}

function parseOptions(argv: readonly string[]): Options {
	const flags = new Set(argv.filter((argument) => argument.startsWith("--")));
	const valueOf = (name: string): string | undefined => {
		const prefix = `--${name}=`;
		const hit = argv.find((argument) => argument.startsWith(prefix));
		if (hit) return hit.slice(prefix.length);
		const index = argv.indexOf(`--${name}`);
		const next = index === -1 ? undefined : argv[index + 1];
		return next && !next.startsWith("--") ? next : undefined;
	};

	return {
		dryRun: flags.has("--dry-run"),
		finalize: flags.has("--finalize"),
		seedFixtures: flags.has("--seed-fixtures"),
		dropFixtures: flags.has("--drop-fixtures"),
		telephonyUrl: valueOf("telephony-url") ?? process.env.API_DATABASE_URL ?? DEFAULT_TELEPHONY_URL,
		baseUrl: valueOf("base-url") ?? process.env.DATABASE_URL ?? DEFAULT_BASE_URL,
		json: flags.has("--json"),
	};
}

// -------------------------------------------------------------------------------------------
// The ledger
// -------------------------------------------------------------------------------------------

async function readLedger(baseUrl: string): Promise<TenantLedger> {
	const client = postgres(baseUrl, { max: 1, onnotice: () => undefined });
	try {
		const mappings = await client<{ accessKeyId: string; organizationId: string }[]>`
			select access_key_id as "accessKeyId", organization_id as "organizationId"
			from legacy_workspace_organization
		`;
		const organizations = await client<{ id: string }[]>`select id from organization`;
		return {
			byAccessKey: new Map(
				mappings.map(({ accessKeyId, organizationId }) => [
					accessKeyId.trim(),
					organizationId.toLowerCase(),
				]),
			),
			organizationIds: new Set(organizations.map(({ id }) => id.toLowerCase())),
		};
	} catch (error) {
		throw new TenancyBackfillError(
			`Could not read the Step 2 mapping ledger from ${redact(baseUrl)}: ${String(error)}. ` +
				"Run `pnpm --filter @optimiq-voice/api migrate:identity` first.",
		);
	} finally {
		await client.end({ timeout: 5 });
	}
}

function redact(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return "<unparseable url>";
	}
}

// -------------------------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------------------------

/**
 * Synthetic telephony rows for a machine whose api database is empty.
 *
 * They are keyed by whatever `WO…` keys the ledger actually holds, so the fixture set is a
 * function of the Step 2 migration rather than a second, independently drifting constant — seed
 * `migrate:identity -- --seed-fixtures` first and this produces a couple of workspaces' worth of
 * applications, their service rows and their secrets.
 */
async function seedFixtures(sql: Sql, ledger: TenantLedger): Promise<number> {
	const accessKeys = [...ledger.byAccessKey.keys()].sort();
	if (accessKeys.length === 0) {
		throw new TenancyBackfillError(
			"The mapping ledger is empty, so there are no access keys to build fixtures from. " +
				"Run `pnpm --filter @optimiq-voice/api migrate:identity -- --seed-fixtures` first.",
		);
	}

	let written = 0;
	await sql.begin(async (tx) => {
		await tx`
			insert into products (ref, name, vendor, type)
			values (${`${FIXTURE_TAG}-product`}, 'Fixture TTS', 'GENERIC', 'TTS')
			on conflict (ref) do nothing
		`;

		for (const [index, accessKeyId] of accessKeys.entries()) {
			// Two applications and two secrets per tenant, so a list query has something to page.
			for (const slot of [1, 2]) {
				const applicationRef = `${FIXTURE_TAG}-app-${String(index)}-${String(slot)}`;
				await tx`
					insert into applications (ref, access_key_id, name, type, endpoint)
					values (${applicationRef}, ${accessKeyId},
					        ${`Fixture App ${String(index)}.${String(slot)}`},
					        ${slot === 1 ? "AUTOPILOT" : "EXTERNAL"}, 'localhost:50061')
					on conflict (ref) do nothing
				`;
				await tx`
					insert into tts_services (ref, config, credentials_hash, application_ref, product_ref)
					values (${`${FIXTURE_TAG}-tts-${String(index)}-${String(slot)}`},
					        ${sql.json({ voice: "fixture" })}, null, ${applicationRef},
					        ${`${FIXTURE_TAG}-product`})
					on conflict (ref) do nothing
				`;
				await tx`
					insert into secrets (ref, access_key_id, secret_hash, name)
					values (${`${FIXTURE_TAG}-secret-${String(index)}-${String(slot)}`}, ${accessKeyId},
					        ${`fixture-secret-${String(index)}-${String(slot)}`},
					        ${`fixture-secret-${String(index)}-${String(slot)}`})
					on conflict (ref) do nothing
				`;
				written += 3;
			}
		}
	});
	return written;
}

async function dropFixtures(sql: Sql): Promise<void> {
	await sql.begin(async (tx) => {
		await tx`delete from tts_services where ref like ${`${FIXTURE_TAG}%`}`;
		await tx`delete from stt_services where ref like ${`${FIXTURE_TAG}%`}`;
		await tx`delete from intelligence_services where ref like ${`${FIXTURE_TAG}%`}`;
		await tx`delete from applications where ref like ${`${FIXTURE_TAG}%`}`;
		await tx`delete from secrets where ref like ${`${FIXTURE_TAG}%`}`;
		await tx`delete from products where ref like ${`${FIXTURE_TAG}%`}`;
	});
}

// -------------------------------------------------------------------------------------------
// The backfill
// -------------------------------------------------------------------------------------------

interface BackfillReport {
	readonly perTable: Map<string, TenantRowCounts>;
	readonly unresolvedSamples: Map<string, string[]>;
}

/**
 * `applications` / `secrets` carry the tenant themselves. Grouping by the distinct access key
 * keeps this one UPDATE per tenant instead of one per row, which matters on a real dataset.
 */
async function backfillSourceTable(
	tx: TransactionSql,
	table: TenantSourceTable,
	ledger: TenantLedger,
	report: BackfillReport,
): Promise<void> {
	const counts = report.perTable.get(table) ?? emptyTenantRowCounts();
	const samples = report.unresolvedSamples.get(table) ?? [];

	const [scoped] = await tx<{ count: string }[]>`
		select count(*)::text as count from ${tx(table)} where organization_id is not null
	`;
	let next = { ...counts, alreadyScoped: Number(scoped?.count ?? "0") };

	const groups = await tx<{ accessKeyId: string | null; count: string }[]>`
		select access_key_id as "accessKeyId", count(*)::text as count
		from ${tx(table)}
		where organization_id is null
		group by access_key_id
	`;

	for (const group of groups) {
		const rows = Number(group.count);
		const resolution = resolveOrganizationId(group.accessKeyId, ledger);
		for (let index = 0; index < rows; index += 1) {
			next = addResolution(next, resolution);
		}
		if (resolution.kind === "mapped" || resolution.kind === "self") {
			await tx`
				update ${tx(table)}
				set organization_id = ${resolution.organizationId}::uuid
				where organization_id is null and access_key_id = ${group.accessKeyId as string}
			`;
		} else {
			samples.push(resolution.kind === "blank" ? "<blank>" : resolution.accessKeyId);
		}
	}

	report.perTable.set(table, next);
	report.unresolvedSamples.set(table, samples);
}

/**
 * The service tables hang off an application and have no access key of their own, so they inherit
 * whatever the parent resolved to. Running after the source pass is what makes that correct.
 */
async function backfillDerivedTable(
	tx: TransactionSql,
	table: TenantDerivedTable,
	report: BackfillReport,
): Promise<void> {
	const [scoped] = await tx<{ count: string }[]>`
		select count(*)::text as count from ${tx(table)} where organization_id is not null
	`;
	const updated = await tx<{ ref: string }[]>`
		update ${tx(table)} as service
		set organization_id = application.organization_id
		from applications as application
		where service.application_ref = application.ref
			and service.organization_id is null
			and application.organization_id is not null
		returning service.ref
	`;
	const [remaining] = await tx<{ count: string }[]>`
		select count(*)::text as count from ${tx(table)} where organization_id is null
	`;

	report.perTable.set(table, {
		...emptyTenantRowCounts(),
		alreadyScoped: Number(scoped?.count ?? "0"),
		mapped: updated.length,
		unmapped: Number(remaining?.count ?? "0"),
	});
	if (Number(remaining?.count ?? "0") > 0) {
		report.unresolvedSamples.set(table, ["<parent application is itself unscoped>"]);
	}
}

/**
 * `SET NOT NULL` is applied here rather than by the migration that declares it, so the
 * constraint can never be reached before the data supports it. The migration
 * `…_tenancy_organization_id_not_null` repeats the statement (it is idempotent) behind the same
 * guard, so a fresh install — which has no rows and therefore nothing to backfill — still gets
 * the constraint through the ordinary deploy path.
 */
async function finalize(tx: TransactionSql, report: BackfillReport): Promise<void> {
	const blockers = findFinalizationBlockers(report.perTable);
	if (blockers.length > 0) {
		throw new TenancyBackfillError(
			`Refusing to apply NOT NULL while rows are unattributed:\n  - ${blockers.join("\n  - ")}\n` +
				"Every such row must be mapped (or removed) before the tenant column can be enforced.",
		);
	}
	for (const table of TENANT_TABLES) {
		await tx`alter table ${tx(table)} alter column organization_id set not null`;
	}
}

// -------------------------------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------------------------------

const ROLLBACK_SENTINEL = Symbol("dry-run-rollback");

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const started = Date.now();
	const sql = postgres(options.telephonyUrl, { max: 1, onnotice: () => undefined });

	try {
		if (options.dropFixtures) {
			await dropFixtures(sql);
			process.stdout.write("tenancy fixtures dropped\n");
			return;
		}

		const ledger = await readLedger(options.baseUrl);

		if (options.seedFixtures) {
			const written = await seedFixtures(sql, ledger);
			process.stdout.write(
				`tenancy fixtures seeded · ${String(written)} rows across ${String(ledger.byAccessKey.size)} tenants\n`,
			);
		}

		const report: BackfillReport = { perTable: new Map(), unresolvedSamples: new Map() };

		try {
			await sql.begin(async (tx) => {
				for (const table of TENANT_SOURCE_TABLES) {
					await backfillSourceTable(tx, table, ledger, report);
				}
				for (const table of TENANT_DERIVED_TABLES) {
					await backfillDerivedTable(tx, table, report);
				}
				if (options.finalize) {
					await finalize(tx, report);
				}
				if (options.dryRun) {
					throw ROLLBACK_SENTINEL;
				}
			});
		} catch (error) {
			if (error !== ROLLBACK_SENTINEL) {
				throw error;
			}
		}

		printReport(options, report, Date.now() - started);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

function printReport(options: Options, report: BackfillReport, elapsedMs: number): void {
	const tables = Object.fromEntries(
		[...report.perTable.entries()].map(([table, counts]) => [table, counts]),
	);

	if (options.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					applied: !options.dryRun,
					finalized: options.finalize && !options.dryRun,
					elapsedMs,
					tables,
					unresolved: Object.fromEntries(report.unresolvedSamples),
				},
				null,
				2,
			)}\n`,
		);
		return;
	}

	const mode = options.dryRun ? "DRY RUN" : "APPLIED";
	process.stdout.write(
		`tenancy organization_id backfill · ${mode}${options.finalize ? " + NOT NULL" : ""} · ${String(elapsedMs)}ms\n`,
	);
	process.stdout.write(`  telephony  ${redact(options.telephonyUrl)}\n`);
	process.stdout.write(`  ledger     ${redact(options.baseUrl)}\n`);
	for (const table of TENANT_TABLES) {
		const counts = report.perTable.get(table);
		if (!counts) continue;
		process.stdout.write(
			`  ${table.padEnd(22)} scoped=${String(counts.alreadyScoped)} mapped=${String(counts.mapped)} self=${String(counts.selfMapped)} blank=${String(counts.blank)} unmapped=${String(counts.unmapped)}\n`,
		);
	}
	const unresolvedTotal = [...report.perTable.values()].reduce(
		(total, counts) => total + unresolvedRowCount(counts),
		0,
	);
	if (unresolvedTotal > 0) {
		process.stdout.write(`  ! ${String(unresolvedTotal)} row(s) remain unattributed\n`);
		for (const [table, samples] of report.unresolvedSamples) {
			if (samples.length > 0) {
				process.stdout.write(`    ${table}: ${[...new Set(samples)].slice(0, 5).join(", ")}\n`);
			}
		}
	}
}

await main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
