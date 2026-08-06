/**
 * Seeds a small, realistic call history into `cdr-db` for one organization.
 *
 *   CDR_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_cdr \
 *     pnpm --filter @optimiq-voice/api seed:cdr --organization <uuid>
 *
 * The counterpart to `seed-pbx-demo.ts`, and it exists for the same two reasons: a developer
 * opening `/cdr` against an empty database cannot tell an unfinished screen from an empty one, and
 * `apps/web`'s smoke needs rows it did not have to invent the shape of.
 *
 * It writes through the OWNER principal inside `withCdrWriterScope`, which is the same path the
 * durable writer takes — deliberately, so the seed cannot produce rows the writer could not have.
 * It does NOT go through NATS: the broker round trip is what `verify:cdr` proves, and a seeder that
 * needed a running broker would be useless for exactly the case it exists for.
 *
 * Everything it writes is idempotent on the composite primary key, so running it twice against one
 * organization leaves one copy.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	callLegs,
	createCdrDatabaseClient,
	createMonthlyPartition,
	eq,
	recordings,
	resolveCdrDatabaseUrl,
	withCdrWriterScope,
} from "@optimiq-voice/cdr-db";
import { createEntityId } from "@optimiq-voice/identifiers";

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
	return process.argv.includes(`--${name}`);
}

interface SeedLeg {
	readonly id: string;
	readonly callId: string;
	readonly leg: "a" | "b";
	readonly originatingLegId: string | null;
	readonly direction: "inbound" | "outbound" | "internal";
	readonly fromNumber: string;
	readonly fromName: string | null;
	readonly toNumber: string;
	readonly destinationType:
		| "extension"
		| "queue"
		| "ivr"
		| "ring_group"
		| "voicemail"
		| "external"
		| "trunk";
	readonly minutesAgo: number;
	readonly durationMs: number;
	readonly billsecMs: number;
	readonly hangupCause: string;
	readonly hangupCauseCode: number;
	readonly hangupSide: "caller" | "callee" | "system" | null;
	readonly disposition: "answered" | "no-answer" | "busy" | "failed" | "voicemail";
}

/**
 * One inbound ring-group call that answered, one that went to voicemail, one outbound, one busy.
 *
 * Four calls rather than four hundred, and each one a DIFFERENT shape: the screens being seeded for
 * are about outcome badges, leg trees and media, and a hundred identical answered calls exercise
 * none of that.
 */
function seedLegs(): readonly SeedLeg[] {
	const inboundCall = createEntityId();
	const inboundALeg = createEntityId();
	const voicemailCall = createEntityId();
	const voicemailALeg = createEntityId();

	return [
		{
			id: inboundALeg,
			callId: inboundCall,
			leg: "a",
			originatingLegId: null,
			direction: "inbound",
			fromNumber: "+12125550100",
			fromName: "Dana Whitfield",
			toNumber: "2000",
			destinationType: "ring_group",
			minutesAgo: 42,
			durationMs: 61_000,
			billsecMs: 47_000,
			hangupCause: "NORMAL_CLEARING",
			hangupCauseCode: 16,
			hangupSide: "caller",
			disposition: "answered",
		},
		{
			id: createEntityId(),
			callId: inboundCall,
			leg: "b",
			originatingLegId: inboundALeg,
			direction: "internal",
			fromNumber: "2000",
			fromName: null,
			toNumber: "1001",
			destinationType: "extension",
			minutesAgo: 41,
			durationMs: 49_000,
			billsecMs: 47_000,
			hangupCause: "NORMAL_CLEARING",
			hangupCauseCode: 16,
			hangupSide: "callee",
			disposition: "answered",
		},
		{
			id: createEntityId(),
			callId: inboundCall,
			leg: "b",
			originatingLegId: inboundALeg,
			direction: "internal",
			fromNumber: "2000",
			fromName: null,
			toNumber: "1002",
			destinationType: "extension",
			minutesAgo: 41,
			durationMs: 12_000,
			billsecMs: 0,
			hangupCause: "LOSE_RACE",
			hangupCauseCode: 502,
			hangupSide: "system",
			disposition: "no-answer",
		},
		{
			id: voicemailALeg,
			callId: voicemailCall,
			leg: "a",
			originatingLegId: null,
			direction: "inbound",
			fromNumber: "+13105550188",
			fromName: "Unknown",
			toNumber: "2000",
			destinationType: "voicemail",
			minutesAgo: 95,
			durationMs: 38_000,
			billsecMs: 21_000,
			hangupCause: "NORMAL_CLEARING",
			hangupCauseCode: 16,
			hangupSide: "caller",
			disposition: "voicemail",
		},
		{
			id: createEntityId(),
			callId: createEntityId(),
			leg: "a",
			originatingLegId: null,
			direction: "outbound",
			fromNumber: "1001",
			fromName: "Alice Nguyen",
			toNumber: "+442071234567",
			destinationType: "trunk",
			minutesAgo: 130,
			durationMs: 9_000,
			billsecMs: 0,
			hangupCause: "USER_BUSY",
			hangupCauseCode: 17,
			hangupSide: "callee",
			disposition: "busy",
		},
		{
			id: createEntityId(),
			callId: createEntityId(),
			leg: "a",
			originatingLegId: null,
			direction: "outbound",
			fromNumber: "1002",
			fromName: "Ben Okafor",
			toNumber: "+18005550111",
			destinationType: "trunk",
			minutesAgo: 200,
			durationMs: 4_000,
			billsecMs: 0,
			hangupCause: "GATEWAY_DOWN",
			hangupCauseCode: 807,
			hangupSide: "system",
			disposition: "failed",
		},
	];
}

async function main(): Promise<void> {
	const organizationId = argument("organization");
	if (organizationId === undefined || organizationId.length === 0) {
		throw new Error("--organization <uuid> is required.");
	}
	const url = resolveCdrDatabaseUrl();
	if (url === undefined) {
		throw new Error("CDR_DATABASE_URL must be set.");
	}
	const recordingRoot = process.env.CDR_RECORDING_ROOT ?? "/opt/optimiq-voice/recordings";

	const database = createCdrDatabaseClient({
		url,
		applicationName: "seed-cdr-demo",
		maxConnections: 2,
	});

	try {
		/**
		 * `--purge` removes everything this organization has, as the schema OWNER.
		 *
		 * Deliberately not reachable through the API and never will be: `call_legs` is append-only
		 * for the tenant role, which holds no DELETE privilege at all, so there is no endpoint that
		 * could do this and adding one would undo the property the whole ledger is built on. The
		 * owner CAN, which is why retention and this flag both run here — and why a fixture teardown
		 * is a script an operator invokes rather than a button in a UI.
		 */
		if (flag("purge")) {
			await database.adminDb.delete(recordings).where(eq(recordings.organizationId, organizationId));
			await database.adminDb.delete(callLegs).where(eq(callLegs.organizationId, organizationId));
			process.stdout.write(
				`${JSON.stringify({ event: "cdr_seed_purged", organizationId })}\n`,
			);
			return;
		}

		const legs = seedLegs();
		const now = Date.now();
		// Every seeded leg is inside the last few hours, so one partition covers them all — but the
		// ensure runs anyway, because a seed run in the first minutes of a month must not be the
		// thing that discovers the horizon was not extended.
		await createMonthlyPartition(database.adminDb, "call_legs", new Date(now));

		const answered = legs[0];
		const recordingId = createEntityId();
		const objectKey = `${organizationId}/${answered?.callId ?? "call"}/${recordingId}.wav`;

		await withCdrWriterScope(database.adminDb, organizationId, async (transaction) => {
			for (const leg of legs) {
				const startedAt = new Date(now - leg.minutesAgo * 60_000);
				await transaction
					.insert(callLegs)
					.values({
						id: leg.id,
						organizationId,
						callId: leg.callId,
						leg: leg.leg,
						originatingLegId: leg.originatingLegId,
						direction: leg.direction,
						fromNumber: leg.fromNumber,
						fromName: leg.fromName,
						toNumber: leg.toNumber,
						destinationType: leg.destinationType,
						startedAt,
						answeredAt: leg.billsecMs > 0 ? new Date(startedAt.getTime() + 4_000) : null,
						endedAt: new Date(startedAt.getTime() + leg.durationMs),
						durationMs: leg.durationMs,
						billsecMs: leg.billsecMs,
						hangupCause: leg.hangupCause as never,
						hangupCauseCode: leg.hangupCauseCode,
						hangupSide: leg.hangupSide,
						disposition: leg.disposition,
						recordingKey: leg.id === answered?.id ? objectKey : null,
						raw: { seededBy: "seed-cdr-demo" },
					})
					.onConflictDoNothing();
			}

			if (answered !== undefined) {
				await transaction
					.insert(recordings)
					.values({
						organizationId,
						callId: answered.callId,
						legId: answered.id,
						kind: "call",
						objectKey,
						durationMs: answered.billsecMs,
						sizeBytes: 16,
					})
					.onConflictDoNothing();
			}
		});

		// The media object itself, so the signed-URL path has something to stream. A RIFF header is
		// enough for a player to accept the response and for a smoke to assert on the bytes.
		const path = join(recordingRoot, objectKey);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, Buffer.from("RIFF....WAVEfmt ", "ascii"));

		process.stdout.write(
			`${JSON.stringify({
				event: "cdr_seed_complete",
				organizationId,
				legs: legs.length,
				recordings: 1,
				objectKey,
			})}\n`,
		);
	} finally {
		await database.close();
	}
}

await main();
