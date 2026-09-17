import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createEntityId } from "@optimiq-voice/identifiers";
import { createPbxDatabaseClient, type PbxDatabaseClient } from "./client";
import { conversation, message, messagingNumber, messagingOptOut } from "./schema/messaging-schema";
import { phoneNumber } from "./schema/numbers-schema";

/**
 * Tenant isolation on the messaging tables, proven against a live PostgreSQL.
 *
 * A file of its own rather than four more rows in `pbx-tenant-rls.integration.spec.ts`, because the
 * thing worth proving here is not "these tables have a policy" — the preflight already asserts that
 * for all 74 of them, and would fail the build if one were missing. What is worth proving is the
 * part specific to messaging, and it takes a fixture the general spec does not have:
 *
 * 1. **A conversation is the most sensitive tenant-scoped row this platform holds.** It is a
 *    consumer's phone number and the text of what they said, and unlike an extension or an IVR menu
 *    it is personal data about somebody who is not the tenant's employee. A cross-tenant read here
 *    is a different class of incident from a cross-tenant read of a dial plan.
 * 2. **The suppression list must not leak either way.** Tenant B must not be able to see who opted
 *    out of tenant A's messages (that is a customer list), and — the direction people forget —
 *    tenant B's STOP must not suppress tenant A's number. The pair key is what makes the second
 *    true, and it is asserted here rather than assumed from the index definition.
 * 3. **`messaging_number.e164` is globally unique.** Two tenants claiming one E.164 for messaging is
 *    the same impossible claim `phone_number` already refuses, and the constraint has to hold across
 *    the RLS boundary — a unique index is enforced against rows the inserting role cannot see, and
 *    proving that is the whole point of doing it against a real server.
 *
 * Gated on RUN_DB_INTEGRATION_TESTS and run with `--max-concurrency 1`, like its sibling: it drops
 * into a role and writes real rows.
 */
const databaseUrl = process.env.PBX_DATABASE_MIGRATION_URL ?? process.env.PBX_DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION_TESTS === "true" && Boolean(databaseUrl);

const ORGANIZATION_A = createEntityId();
const ORGANIZATION_B = createEntityId();
const ORGANIZATIONS = [ORGANIZATION_A, ORGANIZATION_B];

/** The consumer both tenants talk to. The same human, two unrelated business relationships. */
const CONSUMER = "+13125559999";

interface PostgresFailure {
	readonly code?: string;
	readonly message?: string;
}

/** Drizzle wraps driver failures, so the SQLSTATE the server returned lives on `cause`. */
async function capturePostgresFailure(work: Promise<unknown>): Promise<PostgresFailure> {
	try {
		await work;
	} catch (error) {
		const cause = (error as { cause?: unknown }).cause ?? error;
		return cause as PostgresFailure;
	}
	throw new Error("Expected the statement to be rejected by PostgreSQL, but it succeeded.");
}

describe.skipIf(!enabled)("messaging tenant row-level security", () => {
	let client: PbxDatabaseClient;
	const numbers = new Map<string, string>();
	const conversations = new Map<string, string>();

	beforeAll(async () => {
		client = createPbxDatabaseClient({
			url: databaseUrl ?? "",
			applicationName: "optimiq-voice-messaging-rls-spec",
			maxConnections: 4,
		});
		for (const [index, organizationId] of ORGANIZATIONS.entries()) {
			const e164 = `+1555010${String(index).padStart(4, "0")}`;
			const [did] = await client.adminDb
				.insert(phoneNumber)
				.values({ organizationId, e164, destinationType: "hangup" })
				.returning({ id: phoneNumber.id });
			const [line] = await client.adminDb
				.insert(messagingNumber)
				.values({ organizationId, phoneNumberId: did?.id ?? "", e164 })
				.returning({ id: messagingNumber.id });
			numbers.set(organizationId, line?.id ?? "");
			const [thread] = await client.adminDb
				.insert(conversation)
				.values({ organizationId, messagingNumberId: line?.id ?? "", remoteE164: CONSUMER })
				.returning({ id: conversation.id });
			conversations.set(organizationId, thread?.id ?? "");
			await client.adminDb.insert(message).values({
				organizationId,
				conversationId: thread?.id ?? "",
				messagingNumberId: line?.id ?? "",
				direction: "inbound",
				status: "received",
				fromE164: CONSUMER,
				toE164: e164,
				body: `a private message for ${organizationId}`,
			});
		}
	});

	afterAll(async () => {
		if (!client) {
			return;
		}
		// Children first: `message` cascades from `conversation`, but `conversation` is `restrict`
		// from `messaging_number`, so the order matters and the sweep would otherwise 23503.
		for (const table of [message, messagingOptOut, conversation, messagingNumber, phoneNumber]) {
			await client.adminDb.delete(table).where(inArray(table.organizationId, ORGANIZATIONS));
		}
		await client.close();
	});

	it("shows a tenant only its own conversations and messages", async () => {
		for (const organizationId of ORGANIZATIONS) {
			const threads = await client.withTenantScope(
				organizationId,
				async (transaction) => await transaction.select().from(conversation),
			);
			expect(threads).toHaveLength(1);
			expect(threads[0]?.organizationId).toBe(organizationId);

			const rows = await client.withTenantScope(
				organizationId,
				async (transaction) => await transaction.select().from(message),
			);
			expect(rows).toHaveLength(1);
			// Both tenants have a thread with the SAME consumer number, so a filter that leaked would
			// return two rows here and look like an ordinary bug rather than an isolation breach.
			expect(rows[0]?.body).toBe(`a private message for ${organizationId}`);
		}
	});

	it("hides another tenant's conversation even when its id is known", async () => {
		const otherThread = conversations.get(ORGANIZATION_B) ?? "";
		const found = await client.withTenantScope(
			ORGANIZATION_A,
			async (transaction) =>
				await transaction.select().from(conversation).where(eq(conversation.id, otherThread)),
		);
		expect(found).toHaveLength(0);
	});

	it("refuses to write a row into another tenant", async () => {
		const failure = await capturePostgresFailure(
			client.withTenantScope(
				ORGANIZATION_A,
				async (transaction) =>
					await transaction.insert(conversation).values({
						// The WITH CHECK half of the policy: a tenant cannot insert a row it would not
						// then be able to see.
						organizationId: ORGANIZATION_B,
						messagingNumberId: numbers.get(ORGANIZATION_B) ?? "",
						remoteE164: CONSUMER,
					}),
			),
		);
		expect(failure.message).toContain("row-level security policy");
	});

	it("keeps one tenant's opt-out from suppressing another tenant's number", async () => {
		await client.withTenantScope(
			ORGANIZATION_A,
			async (transaction) =>
				await transaction.insert(messagingOptOut).values({
					organizationId: ORGANIZATION_A,
					messagingNumberId: numbers.get(ORGANIZATION_A) ?? "",
					remoteE164: CONSUMER,
					source: "keyword",
					keyword: "STOP",
				}),
		);

		// Tenant A sees the suppression.
		const mine = await client.withTenantScope(
			ORGANIZATION_A,
			async (transaction) => await transaction.select().from(messagingOptOut),
		);
		expect(mine).toHaveLength(1);

		// Tenant B sees nothing — not the row, and therefore not the customer list it implies.
		const theirs = await client.withTenantScope(
			ORGANIZATION_B,
			async (transaction) => await transaction.select().from(messagingOptOut),
		);
		expect(theirs).toHaveLength(0);

		// And tenant B can still record its own suppression for the same consumer: the ledger is keyed
		// by the PAIR, so the same human opting out of one business does not opt them out of another.
		const inserted = await client.withTenantScope(
			ORGANIZATION_B,
			async (transaction) =>
				await transaction
					.insert(messagingOptOut)
					.values({
						organizationId: ORGANIZATION_B,
						messagingNumberId: numbers.get(ORGANIZATION_B) ?? "",
						remoteE164: CONSUMER,
						source: "keyword",
						keyword: "STOP",
					})
					.returning({ id: messagingOptOut.id }),
		);
		expect(inserted).toHaveLength(1);
	});

	it("lets exactly one tenant claim an E.164 for messaging, across the RLS boundary", async () => {
		const taken = await client.adminDb
			.select({ e164: messagingNumber.e164 })
			.from(messagingNumber)
			.where(eq(messagingNumber.organizationId, ORGANIZATION_A));
		const contested = taken[0]?.e164 ?? "";

		const [did] = await client.adminDb
			.insert(phoneNumber)
			.values({
				organizationId: ORGANIZATION_B,
				e164: `${contested}0`,
				destinationType: "hangup",
			})
			.returning({ id: phoneNumber.id });

		// Tenant B cannot SEE tenant A's row, and the unique index still refuses the write — which is
		// the property that matters: a unique index is enforced against every row in the table,
		// including the ones the inserting role's policy hides.
		const failure = await capturePostgresFailure(
			client.withTenantScope(
				ORGANIZATION_B,
				async (transaction) =>
					await transaction.insert(messagingNumber).values({
						organizationId: ORGANIZATION_B,
						phoneNumberId: did?.id ?? "",
						e164: contested,
					}),
			),
		);
		expect(failure.code).toBe("23505");
	});
});
