import { expect } from "chai";
import { VoicemailRetentionSweeper } from "../../src/pbx/voicemail-boxes/voicemail-retention-sweeper.service";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { VoicemailMwiPublisher } from "../../src/pbx/voicemail-boxes/voicemail-mwi.publisher";
import type { ObjectStore } from "../../src/storage";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The voicemail retention purge.
 *
 * Written from the same direction as the CDR recording sweep's spec, because the hazard is the
 * same one: a row deleted before its object is a message the API says is gone while the audio is
 * still in the store — destroyed for the customer and retained for a subpoena. So the cases below
 * are about the ORDER of the two deletes, about what happens when the store refuses half a batch,
 * and about the default that decides whether a tenant is touched at all.
 *
 * The last of those is the one an upgrade turns on: an organization with no `voicemailRetentionDays`
 * row, or a row of `0`, must not be in the worklist. A sweeper that shipped with a release and
 * began destroying messages nobody asked it to destroy is the failure this whole design is arranged
 * against.
 */

const ORG_A = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ORG_B = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";
const BOX = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01";
/** Real UUIDs: `resource_ref` is a uuid column and `asUuid` degrades anything else to NULL. */
const KEEPS = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01";
const GOES = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c02";

interface StoredMessage {
	readonly id: string;
	readonly organizationId: string;
	readonly objectKey: string;
	readonly ageDays: number;
}

interface LedgerRow {
	readonly action: string;
	readonly resourceRef: string | null;
	readonly before: Record<string, unknown> | null;
}

function env(overrides: Partial<PbxEnv> = {}): PbxEnv {
	return {
		PBX_VOICEMAIL_RETENTION_SWEEP_INTERVAL_MS: 3_600_000,
		PBX_VOICEMAIL_RETENTION_SWEEP_BATCH: 200,
		...overrides,
	} as PbxEnv;
}

/**
 * A `PbxDatabaseClient` made of two arrays and a settings map.
 *
 * `adminDb.execute` answers the untenanted settings scan; `withTenantScope` runs the callback
 * against a transaction whose `select` answers the tenant's expired messages and whose `delete`
 * removes them. The point of the fake is the ORDERING it can observe — which is why the deletes
 * and the store's are pushed onto one shared list.
 */
function fakeDatabase(
	windows: readonly { organizationId: string; value: unknown }[],
	messages: readonly StoredMessage[],
	trace: string[],
): { readonly database: PbxDatabaseClient; readonly ledger: LedgerRow[] } {
	const ledger: LedgerRow[] = [];
	const live = [...messages];
	const database = {
		adminDb: {
			execute: async () =>
				await Promise.resolve(
					windows.map((entry) => ({
						organization_id: entry.organizationId,
						value: entry.value,
					})),
				),
		},
		withTenantScope: async (
			organizationId: string,
			run: (transaction: unknown) => Promise<unknown>,
		) => {
			const transaction = {
				select: (shape: Record<string, unknown>) => {
					// The box lookup selects `mailboxNumber`; the worklist does not. One fake, two
					// queries, told apart by what they asked for.
					const isBoxLookup = "mailboxNumber" in shape;
					const rows = isBoxLookup
						? [{ mailboxNumber: "2001", extensionNumber: "1001", mwiEnabled: true }]
						: live
								.filter((message) => message.organizationId === organizationId)
								.map((message) => ({
									id: message.id,
									voicemailBoxId: BOX,
									objectKey: message.objectKey,
									receivedAt: new Date(Date.now() - message.ageDays * 24 * 60 * 60 * 1_000),
								}));
					const builder = {
						from: () => builder,
						leftJoin: () => builder,
						where: () => builder,
						orderBy: () => builder,
						groupBy: async () => await Promise.resolve([]),
						limit: async () => await Promise.resolve(rows),
						then: (resolve: (value: unknown) => unknown) => resolve(rows),
					};
					return builder;
				},
				delete: () => ({
					where: async () => {
						// The id is not visible through this fake's `eq`, so the trace records the
						// operation's ORDER, which is what these cases are about.
						trace.push("row-delete");
						await Promise.resolve();
					},
				}),
				insert: () => ({
					values: async (row: Record<string, unknown>) => {
						ledger.push({
							action: row.action as string,
							resourceRef: row.resourceRef as string | null,
							before: row.before as Record<string, unknown> | null,
						});
						await Promise.resolve();
					},
				}),
			};
			return await run(transaction);
		},
	} as unknown as PbxDatabaseClient;
	return { database, ledger };
}

function fakeStore(
	trace: string[],
	refuse: readonly string[] = [],
): ObjectStore & { readonly deleted: string[] } {
	const deleted: string[] = [];
	return {
		driver: "local",
		deleted,
		delete: async (objectKey: string) => {
			if (refuse.includes(objectKey)) {
				throw new Error("the store is unreachable");
			}
			trace.push("object-delete");
			deleted.push(objectKey);
			await Promise.resolve();
		},
	} as unknown as ObjectStore & { readonly deleted: string[] };
}

/**
 * The lamp publisher, reduced to the one method the sweep calls.
 *
 * The captured ids are returned ALONGSIDE the fake rather than intersected onto its type:
 * `VoicemailMwiPublisher` has a private `published` counter of its own, and an intersection with a
 * public `published` collapses to `never`.
 */
function fakeMwi(): { readonly mwi: VoicemailMwiPublisher; readonly published: string[] } {
	const published: string[] = [];
	const mwi = {
		publish: async (_organizationId: string, mailboxId: string) => {
			published.push(mailboxId);
			return await Promise.resolve(true);
		},
	} as unknown as VoicemailMwiPublisher;
	return { mwi, published };
}

function message(id: string, organizationId: string, ageDays: number): StoredMessage {
	return { id, organizationId, objectKey: `${organizationId}/${id}.wav`, ageDays };
}

describe("voicemail retention sweeper", () => {
	it("removes the object BEFORE the row, copying the service's own ordering", async () => {
		const trace: string[] = [];
		const { database } = fakeDatabase(
			[{ organizationId: ORG_A, value: 30 }],
			[message(GOES, ORG_A, 90)],
			trace,
		);
		const store = fakeStore(trace);
		const sweeper = new VoicemailRetentionSweeper(env(), database, store, fakeMwi().mwi);

		const result = await sweeper.sweep();

		expect(result.purged).to.equal(1);
		// The whole design in one assertion: a row deleted first is a message the API says is gone
		// while the audio is still in the store.
		expect(trace).to.deep.equal(["object-delete", "row-delete"]);
		expect(store.deleted).to.deep.equal([`${ORG_A}/${GOES}.wav`]);
	});

	it("never touches an organization that has not set a finite window", async () => {
		const trace: string[] = [];
		const { database } = fakeDatabase(
			// No row at all for ORG_B, and an explicit "keep for ever" for ORG_A.
			[{ organizationId: ORG_A, value: 0 }],
			[message("m1", ORG_A, 4_000), message("m2", ORG_B, 4_000)],
			trace,
		);
		const store = fakeStore(trace);
		const sweeper = new VoicemailRetentionSweeper(env(), database, store, fakeMwi().mwi);

		const result = await sweeper.sweep();

		// The default a release ships with must be "keep", not "delete what nobody claimed".
		expect(result.purged).to.equal(0);
		expect(store.deleted).to.deep.equal([]);
		expect(trace).to.deep.equal([]);
	});

	it("treats an unreadable window as absent rather than coercing it", async () => {
		const trace: string[] = [];
		const { database } = fakeDatabase(
			[
				{ organizationId: ORG_A, value: "thirty" },
				{ organizationId: ORG_B, value: 30.5 },
			],
			[message("m1", ORG_A, 900), message("m2", ORG_B, 900)],
			trace,
		);
		const sweeper = new VoicemailRetentionSweeper(env(), database, fakeStore(trace), fakeMwi().mwi);

		// A sweeper must be sure of the policy before it deletes: "I could not read the window"
		// resolves to keeping, never to deleting.
		expect((await sweeper.sweep()).purged).to.equal(0);
	});

	it("leaves a message readable and still due when its object could not be removed", async () => {
		const trace: string[] = [];
		const { database, ledger } = fakeDatabase(
			[{ organizationId: ORG_A, value: 30 }],
			[message(KEEPS, ORG_A, 90), message(GOES, ORG_A, 90)],
			trace,
		);
		const store = fakeStore(trace, [`${ORG_A}/${KEEPS}.wav`]);
		const sweeper = new VoicemailRetentionSweeper(env(), database, store, fakeMwi().mwi);

		const result = await sweeper.sweep();

		expect(result.purged).to.equal(1);
		expect(sweeper.stats.unpurgeable).to.equal(1);
		expect(store.deleted).to.deep.equal([`${ORG_A}/${GOES}.wav`]);
		// Only the message whose bytes actually went is in the ledger, and only it lost its row.
		expect(ledger).to.have.length(1);
		expect(ledger[0]?.resourceRef).to.equal(GOES);
	});

	it("audits every purge with the window that permitted it", async () => {
		const trace: string[] = [];
		const { database, ledger } = fakeDatabase(
			[{ organizationId: ORG_A, value: 30 }],
			[message(GOES, ORG_A, 90)],
			trace,
		);
		const sweeper = new VoicemailRetentionSweeper(env(), database, fakeStore(trace), fakeMwi().mwi);

		await sweeper.sweep();

		expect(ledger).to.have.length(1);
		expect(ledger[0]?.action).to.equal("voicemail-message.purge");
		// The window is on the row, because "under what policy was my message destroyed" is the
		// whole question a retention audit exists to answer.
		expect(ledger[0]?.before?.retentionDays).to.equal(30);
		expect(ledger[0]?.before?.objectKey).to.equal(`${ORG_A}/${GOES}.wav`);
	});

	it("republishes the mailbox lamp, so a purged inbox does not leave a lit phone", async () => {
		const trace: string[] = [];
		const { database } = fakeDatabase(
			[{ organizationId: ORG_A, value: 30 }],
			[message(GOES, ORG_A, 90)],
			trace,
		);
		const mwi = fakeMwi();
		const sweeper = new VoicemailRetentionSweeper(env(), database, fakeStore(trace), mwi.mwi);

		await sweeper.sweep();

		expect(mwi.published).to.deep.equal([BOX]);
	});

	it("stops sweeping after shutdown, and schedules nothing when the interval is 0", async () => {
		const trace: string[] = [];
		const { database } = fakeDatabase(
			[{ organizationId: ORG_A, value: 30 }],
			[message(GOES, ORG_A, 90)],
			trace,
		);
		const sweeper = new VoicemailRetentionSweeper(
			env({ PBX_VOICEMAIL_RETENTION_SWEEP_INTERVAL_MS: 0 }),
			database,
			fakeStore(trace),
			fakeMwi().mwi,
		);
		sweeper.onModuleInit();
		sweeper.onApplicationShutdown();

		expect((await sweeper.sweep()).purged).to.equal(0);
		expect(sweeper.stats.swept).to.equal(0);
	});
});
