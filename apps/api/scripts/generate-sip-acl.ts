/**
 * Renders `acl.conf` from the `sip_acl_entry` table.
 *
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *   PBX_MEDIA_OBJECT_ROOT=/opt/optimiq-voice/recordings \
 *     pnpm --filter @optimiq-voice/api generate:sip-acl
 *
 * ## Why this exists
 *
 * `packages/pbx-db`'s `sip_acl_entry` has been a table with one reader — the provisioning render
 * endpoint's own allowlist — while `apps/asterisk/config/acl.conf` was the literal line
 * `; Placeholder`. The parity audit ranks the consequence fourth and names it the FreeSWITCH
 * inventory's toll-fraud rule #1. This is what makes a row an administrator writes into a rule the
 * SIP edge enforces.
 *
 * ## The delivery, which is the musiconhold generator's and for its reasons
 *
 * `scripts/generate-musiconhold.ts` argues the choice at length and every clause still holds:
 * `apps/api` has no ARI client, ARI's module endpoints are not modelled, port 8088 is not exposed
 * to the API in the shipped stack, there is no AMI client in the repository and 5038 is not exposed
 * either. So the delivery is a file the API generates and the container picks up, with the reload
 * stated as an operator step rather than pretended away.
 *
 * One thing differs from hold music and it is worth its own sentence. A MOH change needs
 * `module reload res_musiconhold.so`; an ACL change needs `module reload res_pjsip.so`. `acl
 * reload` does re-read the named ACLs, but a PJSIP endpoint resolved its ACL once at load and holds
 * the resolved object — so refreshing the names alone leaves the endpoint filtering by the old
 * rules, silently. The endpoints have to be rebuilt.
 *
 * ## Where it writes
 *
 * `<PBX_MEDIA_OBJECT_ROOT>/acl/acl.conf`, under the object root the media server already mounts —
 * so tenant ACLs need no SECOND mount a deployment can forget, exactly as the hold-music classes
 * arrive. `apps/asterisk/run.sh` copies it over the baked permit-all fallback at start.
 *
 * ## Flags
 *
 * `--dry-run` prints the file and writes nothing. `--out <path>` overrides the destination.
 * `--stdout` writes the file to standard output and nothing to disk.
 *
 * ## Exit code
 *
 * Always zero unless the read or the write failed. There is deliberately no "unsound ACL" exit
 * code: every combination of rows renders to a valid file, and the judgements this generator can
 * make — an IPv4-only allowlist on a dual-stack box, a cross-tenant deny — are reported as
 * warnings because each of them is also somebody's correct configuration. A generator that failed a
 * pipeline over one would be a generator an operator learns to run with the check disabled.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPbxDatabaseClient, sipAclEntry } from "@optimiq-voice/pbx-db";
import { renderAclConf } from "../src/pbx/security/acl-conf";
import type { SipAclRow } from "../src/pbx/security/acl-conf";

const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
const DEFAULT_OBJECT_ROOT = "/opt/optimiq-voice/recordings";

const dryRun = process.argv.includes("--dry-run");
const toStdout = process.argv.includes("--stdout");
const outIndex = process.argv.indexOf("--out");
const outOverride = outIndex === -1 ? undefined : process.argv[outIndex + 1];

function log(message: string, detail?: Record<string, unknown>): void {
	console.error(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`);
}

/**
 * Every ACL entry on the platform, read as the OWNER principal.
 *
 * `withTenantScope` is deliberately not used, on the grounds `generate-musiconhold.ts` and
 * `rebuild-queue-membership.ts` both record: it sets one organization id, and the media server has
 * one configuration file for the whole box. Here the cross-tenant read is not merely convenient but
 * load-bearing — a named ACL is the union of every tenant's rules for that scope, and a per-tenant
 * read could not produce it.
 */
async function readEntries(
	database: ReturnType<typeof createPbxDatabaseClient>,
): Promise<readonly SipAclRow[]> {
	const rows = await database.adminDb.select().from(sipAclEntry);
	return rows.map((row) => ({
		id: row.id,
		organizationId: row.organizationId,
		name: row.name,
		network: row.network,
		action: row.action,
		scope: row.scope,
		priority: row.priority,
		enabled: row.enabled,
	}));
}

async function main(): Promise<void> {
	const pbxDatabaseUrl = process.env.PBX_DATABASE_URL ?? DEFAULT_PBX_DATABASE_URL;
	const objectRoot =
		process.env.PBX_MEDIA_OBJECT_ROOT ??
		process.env.PBX_VOICEMAIL_MEDIA_ROOT ??
		process.env.CDR_RECORDING_ROOT ??
		DEFAULT_OBJECT_ROOT;
	const destination = outOverride ?? resolve(objectRoot, "acl", "acl.conf");

	log("rendering acl.conf", {
		database: pbxDatabaseUrl.replace(/\/\/[^@]*@/u, "//***@"),
		objectRoot,
		destination: toStdout ? "(stdout)" : destination,
		dryRun,
	});

	const database = createPbxDatabaseClient({
		url: pbxDatabaseUrl,
		applicationName: "optimiq-sip-acl-generator",
		// 2 is the client's floor; a single-shot generator has no use for more.
		maxConnections: 2,
	});

	try {
		const entries = await readEntries(database);
		const render = renderAclConf(entries, {
			generatedAt: new Date().toISOString(),
			source: `${entries.length} sip_acl_entry row(s)`,
		});

		if (toStdout || dryRun) {
			process.stdout.write(render.body);
		}
		if (!toStdout && !dryRun) {
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, render.body, "utf8");
			log("wrote acl.conf", { destination, bytes: render.body.length });
		}

		for (const section of render.sections) {
			log(`[${section.name}]`, {
				mode: section.mode,
				rules: section.rules,
				organizations: section.organizations,
			});
		}
		for (const warning of render.warnings) {
			log(`warning: ${warning}`);
		}

		if (!dryRun && !toStdout) {
			log(
				"the media server picks this up on restart; to apply it now, run " +
					"`asterisk -rx 'module reload res_pjsip.so'` in the asterisk container — a bare " +
					"`acl reload` refreshes the names but not the endpoints that resolved them",
			);
		}
	} finally {
		await database.close();
	}
}

await main();
