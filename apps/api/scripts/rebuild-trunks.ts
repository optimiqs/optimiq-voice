/**
 * Rebuilds the `trunks` KV bucket from the `trunk` table.
 *
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *   NATS_URL=nats://localhost:4222 \
 *     pnpm --filter @optimiq-voice/api rebuild:trunks
 *
 * ## When this is the answer
 *
 * The bucket is a DERIVED read model (see `src/pbx/trunks/trunk-directory.publisher.ts`), maintained
 * after every write to `trunk`. Three things break that, and all three are repaired here rather than
 * by a retry loop — the same three `rebuild-did-index.ts` names, with the shapes this bucket gives
 * them:
 *
 * 1. **The API died between the commit and the publish.** The carrier is in the database and not in
 *    the bucket, so the SIP edge has no proxy address for it: every outbound call over that trunk
 *    fails at the edge, and a `register` trunk never sends its REGISTER.
 * 2. **The broker lost the bucket** — a fresh cluster, a restored snapshot, a `nats kv del`. Then
 *    NO tenant can dial out, which is the outage this script exists for.
 * 3. **A tenant was deleted** and its entries were never removed, because the publisher only ever
 *    reconciles organizations something wrote to. That is the orphan pass below.
 *
 * ## What it does, and what it deliberately does not
 *
 * It reads every organization that owns a trunk, re-projects each one's directory exactly as the
 * publisher does — through the same `readTrunkDirectoryRows` and `projectTrunkDirectoryEntry`, so a
 * repair cannot disagree with a live publish — and reconciles the bucket. Then it scans the WHOLE
 * key space for entries whose organization no longer owns any trunk at all, which the per-tenant
 * pass structurally cannot see.
 *
 * There is NO cross-tenant conflict check here, and its absence is a property rather than an
 * omission: `kvKeyFor.trunk` is `<orgId>.<trunkId>`, so two tenants cannot contend for one key. That
 * is exactly what `did-index` and `sip-acl` do not have, and why both of those scripts carry a
 * conflict pass and this one does not.
 *
 * It does not touch `trunk.status*` and it does not publish `trunk.evt.v1` — reachability is a
 * transition owned by the edge's OPTIONS pinger, and a rebuild that asserted every carrier was
 * "unknown" again would blank an operator's trunk list for no reason.
 *
 * `--dry-run` prints the plan and writes nothing. `--organization <id>` limits the per-tenant pass
 * to one tenant (the orphan pass is skipped then, since it is a platform-wide question).
 * `--prune-orphans` removes entries whose organization has no trunks left.
 *
 * ## Exit code
 *
 * Non-zero when an orphan was found and left in place, or when a row could not be keyed. A stale
 * directory entry for a deleted tenant is a carrier the edge would still register to, and a pipeline
 * that treated that as a success would let it ship.
 */

import { connect, type NatsConnection } from "nats";
import { natsCredentials } from "@optimiq-voice/config/nats-credentials";
import { ensureKvBuckets, kvKeyFor, TRUNKS_KV } from "@optimiq-voice/events/streams";
import { createPbxDatabaseClient, sql } from "@optimiq-voice/pbx-db";

const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
const DEFAULT_NATS_URL = "nats://localhost:4222";

const dryRun = process.argv.includes("--dry-run");
const pruneOrphans = process.argv.includes("--prune-orphans");
const onlyIndex = process.argv.indexOf("--organization");
const onlyOrganization = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1];

function log(message: string, detail?: Record<string, unknown>): void {
	console.log(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`);
}

/**
 * Every organization that owns a trunk, read as the owner principal.
 *
 * `withTenantScope` is deliberately NOT used for this one query: it sets `role pbx_tenant_tls` and
 * one organization id, which is exactly what "find every tenant" has to see past. Each tenant's
 * trunks are then read back INSIDE its own scope, so the projection runs under the same RLS the API
 * runs under and a policy that stopped applying would show up here rather than being bypassed by
 * the repair tool.
 */
async function readOrganizationIds(
	database: ReturnType<typeof createPbxDatabaseClient>,
): Promise<readonly string[]> {
	const rows = await database.adminDb.execute(
		sql`select distinct "organization_id" from "trunk" order by "organization_id"`,
	);
	const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
		organization_id: string;
	}[];
	return list.map((row) => row.organization_id);
}

async function main(): Promise<void> {
	const pbxDatabaseUrl = process.env.PBX_DATABASE_URL ?? DEFAULT_PBX_DATABASE_URL;
	const natsUrl = process.env.NATS_URL ?? DEFAULT_NATS_URL;

	log("rebuilding the trunks bucket", {
		database: pbxDatabaseUrl.replace(/\/\/[^@]*@/u, "//***@"),
		nats: natsUrl,
		dryRun,
		pruneOrphans,
		organization: onlyOrganization ?? "(all)",
	});

	// Imported dynamically for the reason `rebuild-queue-membership.ts` does it: the publisher module
	// pulls in `nats` and the Nest decorators, and this script wants its own connection rather than
	// the module's.
	const { projectTrunkDirectoryEntry, readTrunkDirectoryRows } =
		await import("../src/pbx/trunks/trunk-directory.publisher");

	const database = createPbxDatabaseClient({
		url: pbxDatabaseUrl,
		applicationName: "rebuild-trunks",
		poolMaxConnectionsOverride: 2,
	});

	let connection: NatsConnection | undefined;
	let failures = 0;

	try {
		const owners = await readOrganizationIds(database);
		const organizations = onlyOrganization === undefined ? owners : [onlyOrganization];
		log(`read ${String(owners.length)} organization(s) with trunks`);

		connection = await connect({
			servers: natsUrl,
			...natsCredentials(process.env),
			name: "rebuild-trunks",
		});
		const manager = await connection.jetstreamManager();
		await ensureKvBuckets(manager, [TRUNKS_KV]);
		const bucket = await manager.jetstream().views.kv(TRUNKS_KV.name);

		let written = 0;
		let removed = 0;

		for (const organizationId of organizations) {
			const rows = await database.withTenantScope(
				organizationId,
				async (transaction) => await readTrunkDirectoryRows(transaction),
			);

			const existingKeys = new Set<string>();
			for await (const key of await bucket.keys(`${organizationId}.*`)) {
				existingKeys.add(key);
			}

			const wanted = new Set<string>();
			for (const row of rows) {
				let key: string;
				try {
					key = kvKeyFor.trunk(organizationId, row.id);
				} catch {
					failures += 1;
					log("SKIP: a trunk whose id is not a key token cannot be published", {
						organizationId,
						trunkId: row.id,
					});
					continue;
				}
				wanted.add(key);
				if (!dryRun) {
					const entry = projectTrunkDirectoryEntry(organizationId, row);
					await bucket.put(key, new TextEncoder().encode(JSON.stringify(entry)));
				}
				written += 1;
			}

			for (const key of existingKeys) {
				if (wanted.has(key)) {
					continue;
				}
				if (!dryRun) {
					await bucket.delete(key);
				}
				removed += 1;
			}

			log(`organization ${organizationId}`, {
				trunks: rows.length,
				removed: [...existingKeys].filter((key) => !wanted.has(key)).length,
			});
		}

		// The orphan pass. A per-tenant reconcile cannot reach an organization that has no rows left,
		// so a deleted tenant's carriers stay in the bucket for as long as the bucket does — and a
		// `register` trunk in there is one the edge would keep authenticating to on that tenant's
		// behalf. Skipped under `--organization`, because "which organizations still exist?" is a
		// platform-wide question and answering it from one tenant's run would delete everybody else's.
		let orphans = 0;
		if (onlyOrganization === undefined) {
			const live = new Set(owners);
			for await (const key of await bucket.keys()) {
				const organizationId = key.split(".")[0];
				if (organizationId === undefined || live.has(organizationId)) {
					continue;
				}
				orphans += 1;
				if (pruneOrphans) {
					if (!dryRun) {
						await bucket.delete(key);
					}
					removed += 1;
					log("PRUNED an orphan: no trunk rows for this organization", { key, organizationId });
					continue;
				}
				failures += 1;
				log("ORPHAN: no trunk rows for this organization; pass --prune-orphans to remove", {
					key,
					organizationId,
				});
			}
		}

		log(dryRun ? "PLAN (nothing was written)" : "done", {
			written,
			removed,
			orphans,
			failures,
		});
	} finally {
		await database.close();
		if (connection !== undefined && !connection.isClosed()) {
			await connection.drain();
		}
	}

	if (failures > 0) {
		// The rest of the bucket was rebuilt correctly and is usable, but this must not exit 0: an
		// orphan left behind is a carrier the edge still holds configuration for.
		process.exitCode = 1;
	}
}

await main();
