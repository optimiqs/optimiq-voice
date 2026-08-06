/**
 * Seeds one organization with a demo PBX configuration.
 *
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *     pnpm --filter @optimiq-voice/api seed:pbx -- --organization <uuid>
 *
 * The shape is the smallest configuration that exercises every T1 routing path end to end:
 *
 * ```
 *   +12125550100 (DID) ──► "Main line" inbound route ──gated by──► "Business hours"
 *          │                          │                                  │
 *          │                          ▼                                  ├─ open  ─► IVR
 *          │                    IVR "Main menu"                          └─ closed ─► voicemail 8000
 *          │                     1 ─► Sales ring group ─► ext 1001, 1002
 *          │                     2 ─► extension 1003
 *          │                     0 ─► extension 1001
 *          │                     timeout / invalid ─► voicemail 8000
 *          ▼
 *   default destination ─► IVR "Main menu"   (taken when no route matches)
 *
 *                     3 ─► "Support" queue ─► agents 1002, 1003 (tier 1) ─► voicemail on timeout
 *
 *   conference "Standup" (room 9000)
 *   park lot "Front desk" (slots 701–720) ─► voicemail 8000 when nobody retrieves the call
 *
 *   outbound "National" (toll class national, strip 0, prepend +1) ─► trunk "Demo carrier"
 *   feature codes *97 (check voicemail), *69 (redial) and *5 (park into "Front desk")
 * ```
 *
 * It is written directly against `@optimiq-voice/pbx-db` rather than through the HTTP API on
 * purpose: it is a fixture builder, so it must be usable by `verify-pbx.ts` before an application
 * exists, and by a developer who wants data without a session cookie. Everything still goes
 * through `withTenantScope`, so the rows it writes are subject to exactly the RLS policies the
 * API's rows are.
 *
 * Idempotent: it deletes the organization's rows in the six tables it owns before inserting, so
 * running it twice leaves one copy rather than a unique-violation.
 */

import { createEntityId } from "@optimiq-voice/identifiers";
import {
	conference,
	createPbxDatabaseClient,
	extension,
	featureCode,
	inboundRoute,
	ivrMenu,
	ivrMenuOption,
	outboundRoute,
	parkLot,
	phoneNumber,
	queue,
	queueAgent,
	queueTier,
	ringGroup,
	ringGroupDestination,
	sql,
	timeCondition,
	timeConditionRule,
	trunk,
	voicemailBox,
} from "@optimiq-voice/pbx-db";

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";

export interface SeededDemo {
	readonly organizationId: string;
	readonly extensionIds: readonly string[];
	readonly ringGroupId: string;
	readonly ivrMenuId: string;
	readonly voicemailBoxId: string;
	readonly timeConditionId: string;
	readonly phoneNumberId: string;
	readonly inboundRouteId: string;
	readonly outboundRouteId: string;
	readonly trunkId: string;
	readonly queueId: string;
	readonly queueAgentIds: readonly string[];
	readonly conferenceId: string;
	readonly parkLotId: string;
}

/** The tables this fixture owns, in dependency order for the reset. */
const OWNED_TABLES = [
	"inbound_route",
	"outbound_route",
	"phone_number",
	"ivr_menu_option",
	"ivr_menu",
	"ring_group_destination",
	"ring_group",
	// Tiers before the queue and the agents they join: `on delete cascade` would handle it, but the
	// reset must not depend on the order the deletes happen to cascade in.
	"queue_tier",
	"queue_agent",
	"queue",
	"park_lot",
	"conference",
	"time_condition_rule",
	"time_condition",
	"feature_code",
	"voicemail_box",
	"extension",
	"trunk",
] as const;

export async function seedPbxDemo(
	database: ReturnType<typeof createPbxDatabaseClient>,
	organizationId: string,
): Promise<SeededDemo> {
	return await database.withTenantScope(organizationId, async (transaction) => {
		for (const table of OWNED_TABLES) {
			await transaction.execute(sql`delete from ${sql.identifier(table)}`);
		}

		const ids = {
			extensions: [createEntityId(), createEntityId(), createEntityId()],
			ringGroup: createEntityId(),
			ivrMenu: createEntityId(),
			voicemailBox: createEntityId(),
			timeCondition: createEntityId(),
			phoneNumber: createEntityId(),
			inboundRoute: createEntityId(),
			outboundRoute: createEntityId(),
			trunk: createEntityId(),
			queue: createEntityId(),
			queueAgents: [createEntityId(), createEntityId()],
			conference: createEntityId(),
			parkLot: createEntityId(),
		};

		await transaction.insert(extension).values(
			[
				{ number: "1001", label: "Alice Nguyen", tollClass: "international" as const },
				{ number: "1002", label: "Ben Okafor", tollClass: "national" as const },
				{ number: "1003", label: "Carla Reyes", tollClass: "local" as const },
			].map((row, index) => ({
				id: ids.extensions[index] as string,
				organizationId,
				number: row.number,
				label: row.label,
				sipSecretRef: `secret://demo/extension/${row.number}`,
				callerIdName: row.label,
				callerIdNumber: row.number,
				tollClass: row.tollClass,
				voicemailEnabled: true,
			})),
		);

		// The mailbox has to exist before anything routes to it — the compiler refuses a dangling
		// destination, which is exactly the behaviour this fixture must not trip over.
		await transaction.insert(voicemailBox).values({
			id: ids.voicemailBox,
			organizationId,
			mailboxNumber: "8000",
			label: "General voicemail",
			emailAddress: "voicemail@demo.optimiq.test",
			emailMode: "notify",
			mwiEnabled: true,
		});

		await transaction.insert(ringGroup).values({
			id: ids.ringGroup,
			organizationId,
			name: "Sales",
			extensionNumber: "2000",
			strategy: "simultaneous",
			ringTimeoutSeconds: 25,
			callerIdNamePrefix: "[Sales] ",
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: ids.voicemailBox,
		});

		await transaction.insert(ringGroupDestination).values([
			{
				id: createEntityId(),
				organizationId,
				ringGroupId: ids.ringGroup,
				ordinal: 1,
				destinationType: "extension" as const,
				destinationRef: ids.extensions[0] as string,
				timeoutSeconds: 25,
			},
			{
				id: createEntityId(),
				organizationId,
				ringGroupId: ids.ringGroup,
				ordinal: 2,
				destinationType: "extension" as const,
				destinationRef: ids.extensions[1] as string,
				timeoutSeconds: 25,
			},
		]);

		// The queue, its agents and their tier. `queue_agent` and `queue_tier` are not routing inputs
		// — the compiler emits the queue node and the engine reads membership live — so they are
		// seeded purely so the admin screens and the wallboard have something to show.
		await transaction.insert(queue).values({
			id: ids.queue,
			organizationId,
			name: "Support",
			extensionNumber: "2100",
			strategy: "longest-idle",
			maxWaitSeconds: 300,
			announcePositionEnabled: true,
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: ids.voicemailBox,
		});

		await transaction.insert(queueAgent).values(
			[
				{ name: "Ben Okafor", extensionIndex: 1 },
				{ name: "Carla Reyes", extensionIndex: 2 },
			].map((row, index) => ({
				id: ids.queueAgents[index] as string,
				organizationId,
				name: row.name,
				contactKind: "extension" as const,
				extensionId: ids.extensions[row.extensionIndex] as string,
				status: "logged-out" as const,
			})),
		);

		await transaction.insert(queueTier).values(
			ids.queueAgents.map((queueAgentId, index) => ({
				id: createEntityId(),
				organizationId,
				queueId: ids.queue,
				queueAgentId,
				level: 1,
				position: index + 1,
			})),
		);

		await transaction.insert(conference).values({
			id: ids.conference,
			organizationId,
			name: "Standup",
			roomNumber: "9000",
			maxMembers: 25,
			announceJoinLeave: true,
		});

		// A parked call nobody retrieves must go somewhere, or it sits in hold music until the
		// carrier gives up — which is the failure mode the timeout trio exists to prevent.
		await transaction.insert(parkLot).values({
			id: ids.parkLot,
			organizationId,
			name: "Front desk",
			slotStart: 701,
			slotEnd: 720,
			timeoutSeconds: 180,
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: ids.voicemailBox,
		});

		await transaction.insert(ivrMenu).values({
			id: ids.ivrMenu,
			organizationId,
			name: "Main menu",
			extensionNumber: "3000",
			maxDigits: 1,
			directDialEnabled: true,
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: ids.voicemailBox,
			invalidDestinationType: "voicemail",
			invalidDestinationRef: ids.voicemailBox,
		});

		await transaction.insert(ivrMenuOption).values([
			{
				id: createEntityId(),
				organizationId,
				ivrMenuId: ids.ivrMenu,
				ordinal: 1,
				matchKind: "digit" as const,
				matchValue: "1",
				label: "Sales",
				destinationType: "ring-group" as const,
				destinationRef: ids.ringGroup,
			},
			{
				id: createEntityId(),
				organizationId,
				ivrMenuId: ids.ivrMenu,
				ordinal: 2,
				matchKind: "digit" as const,
				matchValue: "2",
				label: "Support",
				destinationType: "extension" as const,
				destinationRef: ids.extensions[2] as string,
			},
			{
				id: createEntityId(),
				organizationId,
				ivrMenuId: ids.ivrMenu,
				ordinal: 3,
				matchKind: "digit" as const,
				matchValue: "3",
				label: "Support queue",
				destinationType: "queue" as const,
				destinationRef: ids.queue,
			},
			{
				id: createEntityId(),
				organizationId,
				ivrMenuId: ids.ivrMenu,
				ordinal: 4,
				matchKind: "digit" as const,
				matchValue: "0",
				label: "Operator",
				destinationType: "extension" as const,
				destinationRef: ids.extensions[0] as string,
			},
		]);

		await transaction.insert(timeCondition).values({
			id: ids.timeCondition,
			organizationId,
			name: "Business hours",
			timezone: "America/New_York",
			// Matched: the IVR. Unmatched: straight to the mailbox.
			destinationType: "ivr",
			destinationRef: ids.ivrMenu,
			nomatchDestinationType: "voicemail",
			nomatchDestinationRef: ids.voicemailBox,
		});

		await transaction.insert(timeConditionRule).values({
			id: createEntityId(),
			organizationId,
			timeConditionId: ids.timeCondition,
			ordinal: 1,
			label: "Weekdays 09:00-17:00",
			predicates: [{ weekdays: [1, 2, 3, 4, 5], timeOfDay: { from: "09:00", to: "17:00" } }],
		});

		await transaction.insert(phoneNumber).values({
			id: ids.phoneNumber,
			organizationId,
			e164: "+12125550100",
			label: "Main line",
			// The DID's own destination is the fallback the compiler uses when no rule matches.
			destinationType: "ivr",
			destinationRef: ids.ivrMenu,
			callerIdNamePrefix: "[Main] ",
		});

		await transaction.insert(inboundRoute).values({
			id: ids.inboundRoute,
			organizationId,
			name: "Main line",
			priority: 100,
			matchKind: "exact",
			matchPattern: "+12125550100",
			phoneNumberId: ids.phoneNumber,
			destinationType: "time-condition",
			destinationRef: ids.timeCondition,
			failoverDestinationType: "voicemail",
			failoverDestinationRef: ids.voicemailBox,
		});

		await transaction.insert(trunk).values({
			id: ids.trunk,
			organizationId,
			name: "Demo carrier",
			kind: "ip-auth",
			sipDomain: "sip.demo-carrier.test",
			sipProxy: "sip.demo-carrier.test:5060",
			transport: "udp",
			codecPrefs: "PCMU,PCMA,OPUS",
			maxChannels: 30,
		});

		await transaction.insert(outboundRoute).values({
			id: ids.outboundRoute,
			organizationId,
			name: "National",
			priority: 100,
			matchKind: "prefix",
			dialPatterns: ["0"],
			// Dial `0` + 10 digits internally; the carrier wants E.164.
			stripDigits: 1,
			prependDigits: "+1",
			tollClass: "national",
			trunkPriority: [{ trunkId: ids.trunk, order: 1 }],
			failoverDestinationType: "hangup",
			failoverDestinationData: { cause: "NORMAL_TEMPORARY_FAILURE" },
		});

		await transaction.insert(featureCode).values([
			{
				id: createEntityId(),
				organizationId,
				code: "*97",
				action: "voicemail-check" as const,
				label: "Check my voicemail",
			},
			{
				id: createEntityId(),
				organizationId,
				code: "*69",
				action: "redial" as const,
				label: "Redial",
			},
			{
				id: createEntityId(),
				organizationId,
				code: "*5",
				action: "call-park" as const,
				// The one parameter the compiler reads: it resolves the lot into a park node.
				params: { lotId: ids.parkLot },
				label: "Park this call",
			},
		]);

		return {
			organizationId,
			extensionIds: ids.extensions,
			ringGroupId: ids.ringGroup,
			ivrMenuId: ids.ivrMenu,
			voicemailBoxId: ids.voicemailBox,
			timeConditionId: ids.timeCondition,
			phoneNumberId: ids.phoneNumber,
			inboundRouteId: ids.inboundRoute,
			outboundRouteId: ids.outboundRoute,
			trunkId: ids.trunk,
			queueId: ids.queue,
			queueAgentIds: ids.queueAgents,
			conferenceId: ids.conference,
			parkLotId: ids.parkLot,
		};
	});
}

/** Deletes everything this fixture owns for an organization. */
export async function resetPbxDemo(
	database: ReturnType<typeof createPbxDatabaseClient>,
	organizationId: string,
): Promise<void> {
	await database.withTenantScope(organizationId, async (transaction) => {
		for (const table of OWNED_TABLES) {
			await transaction.execute(sql`delete from ${sql.identifier(table)}`);
		}
	});
}

function argumentValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
	const organizationId = argumentValue("--organization");
	if (organizationId === undefined) {
		console.error("usage: seed-pbx-demo.ts --organization <uuid> [--database-url <url>]");
		process.exitCode = 1;
		return;
	}

	const database = createPbxDatabaseClient({
		url: argumentValue("--database-url") ?? process.env.PBX_DATABASE_URL ?? DEFAULT_DATABASE_URL,
		applicationName: "seed-pbx-demo",
		poolMaxConnectionsOverride: 2,
	});

	try {
		const seeded = await seedPbxDemo(database, organizationId);
		console.log(`seeded the demo PBX for organization ${organizationId}`);
		console.log(JSON.stringify(seeded, null, 2));
	} finally {
		await database.close();
	}
}

// `import.meta.main` is Bun-only and this runs under tsx, so compare the entry path instead.
if (process.argv[1] !== undefined && process.argv[1].endsWith("seed-pbx-demo.ts")) {
	await main();
}
