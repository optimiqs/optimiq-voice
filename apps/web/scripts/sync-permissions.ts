/**
 * Mirrors the server permission registry into the web app.
 *
 *   pnpm --filter @optimiq-voice/web codegen          # write lib/permissions.generated.ts
 *   pnpm --filter @optimiq-voice/web codegen:check    # fail if it has drifted
 *
 * `packages/auth/src/permissions.ts` is the single source of truth for authorization (see the
 * master plan §4.3). This script is the only supported way its contents reach the browser: the
 * registry is never hand-copied, and the generated module is data only — every predicate that
 * interprets it lives in `lib/permissions.ts` and is cross-checked against the server's own
 * implementation by `lib/permissions.spec.ts`.
 *
 * Only `@optimiq-voice/auth/permissions` is imported. That subpath has no runtime dependencies —
 * no better-auth, no drizzle, no database — so nothing server-side is pulled into the bundle.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	PERMISSION_CATALOG,
	PERMISSIONS,
	SYSTEM_ROLE_IDS,
	SYSTEM_ROLE_TEMPLATES,
} from "@optimiq-voice/auth/permissions";

const OUTPUT_PATH = join(
	dirname(dirname(fileURLToPath(import.meta.url))),
	"lib/permissions.generated.ts",
);

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: packages/auth/src/permissions.ts
 * Regenerate: pnpm --filter @optimiq-voice/web codegen
 *
 * Data only. The predicates that interpret it live in ./permissions.ts.
 */
`;

/** JSON-encodes with the repository's formatting (tabs, double quotes, trailing commas). */
function literal(value: unknown, indent: number): string {
	const pad = "\t".repeat(indent);
	const inner = "\t".repeat(indent + 1);

	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "[]";
		}
		const items = value.map((entry) => `${inner}${literal(entry, indent + 1)},`).join("\n");
		return `[\n${items}\n${pad}]`;
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).map(
			([key, entryValue]) => `${inner}${key}: ${literal(entryValue, indent + 1)},`,
		);
		return `{\n${entries.join("\n")}\n${pad}}`;
	}
	return JSON.stringify(value);
}

function render(): string {
	const permissions = literal([...PERMISSIONS], 0);
	const catalog = literal(
		PERMISSION_CATALOG.map((group) => ({
			resource: group.resource,
			label: group.label,
			description: group.description,
			permissions: group.permissions.map((descriptor) => ({
				permission: descriptor.permission,
				label: descriptor.label,
				description: descriptor.description,
			})),
		})),
		0,
	);
	const roleTemplates = literal(
		SYSTEM_ROLE_TEMPLATES.map((template) => ({
			id: template.id,
			label: template.label,
			description: template.description,
			membershipRole: template.membershipRole,
			permissions: [...template.permissions],
		})),
		0,
	);

	return `${HEADER}
export const PERMISSIONS = ${permissions} as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_SCOPES = ["own", "team", "all"] as const;

export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export interface PermissionDescriptor {
	readonly permission: Permission;
	readonly label: string;
	readonly description: string;
}

export interface PermissionGroup {
	readonly resource: string;
	readonly label: string;
	readonly description: string;
	readonly permissions: readonly PermissionDescriptor[];
}

/** Grouped, human-labelled view of {@link PERMISSIONS}. Drives the role and API-key editors. */
export const PERMISSION_CATALOG: readonly PermissionGroup[] = ${catalog};

export const SYSTEM_ROLE_IDS = ${literal([...SYSTEM_ROLE_IDS], 0)} as const;

export type SystemRoleId = (typeof SYSTEM_ROLE_IDS)[number];

/** The better-auth organization membership roles a template can be stored as. */
export type OrganizationMembershipRole = "owner" | "admin" | "member";

export interface SystemRoleTemplate {
	readonly id: SystemRoleId;
	readonly label: string;
	readonly description: string;
	readonly membershipRole: OrganizationMembershipRole;
	readonly permissions: readonly Permission[];
}

export const SYSTEM_ROLE_TEMPLATES: readonly SystemRoleTemplate[] = ${roleTemplates};
`;
}

async function main(): Promise<void> {
	const checkOnly = process.argv.includes("--check");
	const next = render();

	if (checkOnly) {
		const current = await readFile(OUTPUT_PATH, "utf8").catch(() => null);
		if (current === next) {
			console.log("permissions.generated.ts is up to date.");
			return;
		}
		console.error(
			current === null
				? `${OUTPUT_PATH} is missing. Run: pnpm --filter @optimiq-voice/web codegen`
				: `${OUTPUT_PATH} has drifted from packages/auth/src/permissions.ts. ` +
						"Run: pnpm --filter @optimiq-voice/web codegen",
		);
		process.exitCode = 1;
		return;
	}

	await mkdir(dirname(OUTPUT_PATH), { recursive: true });
	await writeFile(OUTPUT_PATH, next, "utf8");
	console.log(
		`Wrote ${PERMISSIONS.length} permissions and ${SYSTEM_ROLE_TEMPLATES.length} role templates to ${OUTPUT_PATH}.`,
	);
}

await main();
