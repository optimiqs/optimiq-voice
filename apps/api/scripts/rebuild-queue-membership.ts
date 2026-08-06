/**
 * Rebuilds the `queue-membership` KV bucket from `queue`, `queue_agent`, `queue_tier` and
 * `extension`.
 *
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *   NATS_URL=nats://localhost:4222 \
 *     pnpm --filter @optimiq-voice/api rebuild:queue-membership
 *
 * ## When this is the answer
 *
 * The bucket is a DERIVED read model (see `queue-membership.publisher.ts`), maintained after every
 * write to one of those four tables. Three things break that, and all three are repaired here
 * rather than by a retry loop — the same three `rebuild-did-index.ts` names, with the same shapes:
 *
 * 1. **The API died between the commit and the publish.** The tier is in the database and not in
 *    the bucket, so the engine distributes against the previous roster.
 * 2. **The broker lost the bucket** — a fresh cluster, a restored snapshot, a `nats kv del`. Every
 *    queue then has NO roster, which the engine treats as "refuse to distribute": every caller
 *    waits out `maxWaitNoAgentSeconds` and takes the timeout branch.
 * 3. **A seat was dropped as unreachable** and has since been repaired (its extension was
 *    recreated, its contact filled in) without anything else touching the queue.
 *
 * ## What it does, and what it deliberately does not
 *
 * It reads every organization that has a queue, re-projects each one's rosters exactly as the
 * publisher does, and reconciles the bucket — writing what changed and deleting entries for queues
 * that no longer exist. It does NOT touch `agent-state`: a rebuild that reset everybody's
 * availability would log the whole floor out, and availability is not derivable from the database
 * in the first place (the column is a cache of the bucket, not its source).
 *
 * `--dry-run` prints the plan and writes nothing. `--organization <id>` limits it to one tenant.
 *
 * ## Exit code
 *
 * Non-zero when any seat was dropped as unreachable, even though the rest of the bucket was
 * rebuilt correctly. A dropped seat is an agent who will never be offered a call, and a pipeline
 * that treated a partially-staffed platform as a success would let that ship.
 */

import { connect, type NatsConnection } from "nats";
import { natsCredentials } from "@optimiq-voice/config/nats-credentials";
import { ensureKvBuckets, kvKeyFor, QUEUE_MEMBERSHIP_KV } from "@optimiq-voice/events/streams";
import { createPbxDatabaseClient, sql } from "@optimiq-voice/pbx-db";

const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
const DEFAULT_NATS_URL = "nats://localhost:4222";

const dryRun = process.argv.includes("--dry-run");
const onlyIndex = process.argv.indexOf("--organization");
const onlyOrganization = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1];

function log(message: string, detail?: Record<string, unknown>): void {
	console.log(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`);
}

/**
 * Every organization that owns a queue, read as the owner principal.
 *
 * `withTenantScope` is deliberately NOT used for this one query: it sets `role pbx_tenant_tls` and
 * one organization id, which is exactly what "find every tenant" has to see past. Each tenant's
 * rosters are then read back INSIDE its own scope, so the projection itself runs under the same RLS
 * the API runs under and a policy that stopped applying would show up here rather than being
 * bypassed by the repair tool.
 */
async function readOrganizationIds(
	database: ReturnType<typeof createPbxDatabaseClient>,
): Promise<readonly string[]> {
	const rows = await database.adminDb.execute(
		sql`select distinct "organization_id" from "queue" order by "organization_id"`,
	);
	const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
		organization_id: string;
	}[];
	return list.map((row) => row.organization_id);
}

async function main(): Promise<void> {
	const pbxDatabaseUrl = process.env.PBX_DATABASE_URL ?? DEFAULT_PBX_DATABASE_URL;
	const natsUrl = process.env.NATS_URL ?? DEFAULT_NATS_URL;
	const dialTemplate = process.env.PBX_EXTENSION_DIAL_TEMPLATE ?? "PJSIP/{number}";

	log("rebuilding the queue-membership bucket", {
		database: pbxDatabaseUrl.replace(/\/\/[^@]*@/u, "//***@"),
		nats: natsUrl,
		dialTemplate,
		dryRun,
		organization: onlyOrganization ?? "(all)",
	});

	const { projectQueueMemberships } = await import("../src/pbx/queues/queue-membership.projection");
	const { readRosterRows } = await import("../src/pbx/queues/queue-membership.publisher");

	const database = createPbxDatabaseClient({
		url: pbxDatabaseUrl,
		applicationName: "rebuild-queue-membership",
		poolMaxConnectionsOverride: 2,
	});

	let connection: NatsConnection | undefined;
	let unreachableSeats = 0;

	try {
		const organizations =
			onlyOrganization === undefined ? await readOrganizationIds(database) : [onlyOrganization];
		log(`read ${String(organizations.length)} organization(s) with queues`);

		connection = await connect({
			servers: natsUrl,
			...natsCredentials(process.env),
			name: "rebuild-queue-membership",
		});
		const manager = await connection.jetstreamManager();
		await ensureKvBuckets(manager, [QUEUE_MEMBERSHIP_KV]);
		const bucket = await manager.jetstream().views.kv(QUEUE_MEMBERSHIP_KV.name);

		let written = 0;
		let unchanged = 0;
		let removed = 0;

		for (const organizationId of organizations) {
			const rows = await database.withTenantScope(
				organizationId,
				async (transaction) => await readRosterRows(transaction),
			);

			// The previous revision per queue, so the counter advances rather than restarting at 1 —
			// which is the engine's only handle on "was I distributing against an old roster?".
			const previousRevisions = new Map<string, number>();
			const existingKeys = new Set<string>();
			for await (const key of await bucket.keys(`${organizationId}.*`)) {
				existingKeys.add(key);
				const entry = await bucket.get(key);
				if (entry === null || entry.value.length === 0) {
					continue;
				}
				try {
					const value = JSON.parse(new TextDecoder().decode(entry.value)) as {
						queueId?: string;
						revision?: number;
					};
					if (typeof value.queueId === "string") {
						previousRevisions.set(value.queueId, value.revision ?? 0);
					}
				} catch {
					// Unreadable, so it carries no revision worth continuing from. It will be rewritten.
				}
			}

			const { memberships, unreachable } = projectQueueMemberships(
				organizationId,
				rows.queues,
				rows.tiers,
				{ extensionDialTemplate: dialTemplate, previousRevisions },
			);

			for (const seat of unreachable) {
				unreachableSeats += 1;
				log("UNREACHABLE: an agent was left out of a roster; the engine cannot dial them", {
					organizationId,
					...seat,
				});
			}

			const wanted = new Set<string>();
			for (const membership of memberships) {
				const key = kvKeyFor.queueMembership(organizationId, membership.queueId);
				wanted.add(key);
				if (!dryRun) {
					await bucket.put(key, new TextEncoder().encode(JSON.stringify(membership)));
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
				queues: memberships.length,
				seats: memberships.reduce((total, entry) => total + entry.agents.length, 0),
				removed: existingKeys.size - wanted.size,
			});
		}

		log(dryRun ? "PLAN (nothing was written)" : "done", {
			written,
			unchanged,
			removed,
			unreachableSeats,
		});
	} finally {
		await database.close();
		if (connection !== undefined && !connection.isClosed()) {
			await connection.drain();
		}
	}

	if (unreachableSeats > 0) {
		process.exitCode = 1;
	}
}

await main();
