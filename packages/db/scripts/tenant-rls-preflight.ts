/**
 * The shared tenant-RLS preflight runner (identity-removal Step 5, first task).
 *
 *   # this database's own (currently empty) contract
 *   DATABASE_URL=… bun run scripts/tenant-rls-preflight.ts
 *
 *   # a bounded context's contract
 *   bun run scripts/tenant-rls-preflight.ts \
 *     --plan-module ../../pbx-db/src/rls-preflight-plan \
 *     --plan-export PBX_TENANT_RLS_PLAN \
 *     --url postgresql://…/optimiq_pbx
 *
 * `packages/db/package.json` has declared `db:preflight:tenant-rls` since P0, but the script it
 * points at was never written — recorded as a Step 5 blocker in `plans/identity-removal.md`.
 * This is it: a thin wrapper over the exported `runTenantRlsPreflight` +
 * `createPostgresTenantRlsIntrospector`, so CI and a human debugging a deployment can assert the
 * live catalogue matches the contract without booting an application.
 *
 * ## Why it takes a plan module instead of importing one
 *
 * The oikos rule is that the base package owns shared infrastructure and context databases depend
 * on it, never the reverse (`plans/reference/oikos-conventions.md` §5). A static
 * `import … from "@optimiq-voice/pbx-db"` here would invert that. `--plan-module` is a dynamic
 * `import()` of whatever the operator names, so the runner is reusable without the base package
 * acquiring a single dependency on a context package.
 *
 * ## Why an empty plan is not a pass
 *
 * `evaluateTenantRlsPreflight` trivially returns `ok: true` for a plan with no expectations, which
 * would make a misconfigured invocation indistinguishable from a green gate. The output therefore
 * carries `planEmpty`, and `--require-tables` turns an empty plan into a non-zero exit for callers
 * that must assert something was actually checked.
 */

import {
	createPostgresTenantRlsIntrospector,
	runTenantRlsPreflight,
	type TenantRlsPreflightPlan,
} from "../src/index";
import { BASE_TENANT_RLS_PLAN } from "../src/rls-preflight-plan";

interface Options {
	readonly planModule: string | undefined;
	readonly planExport: string | undefined;
	readonly url: string | undefined;
	readonly requireTables: boolean;
	readonly verbose: boolean;
}

function parseOptions(argv: readonly string[]): Options {
	const valueOf = (name: string): string | undefined => {
		const prefix = `--${name}=`;
		const inline = argv.find((argument) => argument.startsWith(prefix));
		if (inline) return inline.slice(prefix.length);
		const index = argv.indexOf(`--${name}`);
		const next = index === -1 ? undefined : argv[index + 1];
		return next && !next.startsWith("--") ? next : undefined;
	};
	return {
		planModule: valueOf("plan-module"),
		planExport: valueOf("plan-export"),
		url: valueOf("url"),
		requireTables: argv.includes("--require-tables"),
		verbose: argv.includes("--verbose"),
	};
}

function isPlan(value: unknown): value is TenantRlsPreflightPlan {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { roleName?: unknown }).roleName === "string" &&
		Array.isArray((value as { expectations?: unknown }).expectations)
	);
}

async function loadPlan(options: Options): Promise<TenantRlsPreflightPlan> {
	if (!options.planModule) {
		return BASE_TENANT_RLS_PLAN;
	}
	const loaded = (await import(options.planModule)) as Record<string, unknown>;
	if (options.planExport) {
		const named = loaded[options.planExport];
		if (!isPlan(named)) {
			throw new TypeError(
				`${options.planModule} has no tenant RLS plan exported as "${options.planExport}"`,
			);
		}
		return named;
	}
	// No `--plan-export`: take the default export, then the single plan-shaped named export.
	const candidates = Object.entries(loaded).filter(([, value]) => isPlan(value));
	const preferred = candidates.find(([name]) => name === "default") ?? candidates[0];
	if (!preferred) {
		throw new TypeError(`${options.planModule} exports no tenant RLS plan`);
	}
	if (candidates.length > 1 && preferred[0] !== "default") {
		throw new TypeError(
			`${options.planModule} exports ${String(candidates.length)} plans ` +
				`(${candidates.map(([name]) => name).join(", ")}); pass --plan-export`,
		);
	}
	return preferred[1] as TenantRlsPreflightPlan;
}

function resolveUrl(options: Options): string {
	const url =
		options.url ??
		process.env.TENANT_RLS_DATABASE_URL ??
		process.env.DATABASE_MIGRATION_URL ??
		process.env.DATABASE_URL;
	if (!url) {
		throw new Error(
			"Pass --url, or set TENANT_RLS_DATABASE_URL / DATABASE_MIGRATION_URL / DATABASE_URL.",
		);
	}
	return url;
}

const options = parseOptions(process.argv.slice(2));
const plan = await loadPlan(options);
const url = resolveUrl(options);
const planEmpty = plan.expectations.length === 0;

const preflight = planEmpty
	? { ok: true, errors: [] as readonly string[], tables: [] }
	: await runTenantRlsPreflight(plan, createPostgresTenantRlsIntrospector(url));

process.stdout.write(
	`${JSON.stringify({
		event: "tenant_rls_preflight",
		ok: preflight.ok && !(planEmpty && options.requireTables),
		role: plan.roleName,
		schema: plan.schemaName ?? "public",
		planModule: options.planModule ?? "@optimiq-voice/db (base)",
		planEmpty,
		expected: plan.expectations.length,
		introspected: preflight.tables.length,
		errors: preflight.errors,
		...(options.verbose ? { tables: preflight.tables } : {}),
	})}\n`,
);

if (planEmpty && options.requireTables) {
	process.stderr.write(
		"The plan declares no tenant-scoped tables, and --require-tables was passed.\n",
	);
	process.exit(1);
}
if (!preflight.ok) {
	process.exit(1);
}
