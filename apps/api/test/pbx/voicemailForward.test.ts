import { Readable } from "node:stream";
import { expect } from "chai";
import { auditLog, extensionUser, voicemailBox } from "@optimiq-voice/pbx-db";
import { VoicemailMessagesService } from "../../src/pbx/voicemail-boxes/voicemail-messages.service";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * Forwarding and copying a voicemail message.
 *
 * The feature that was a flat 404 (`E2E-routing2.md` P2-2). Four things about it can be wrong in
 * ways nobody notices until a user's message is in the wrong mailbox or in nobody's, and none of
 * them need a database:
 *
 *  1. **Reach** — the SOURCE box takes the `.own` narrowing (a self-service user forwards out of
 *     their own mailbox and no one else's); the TARGET takes tenancy only, because a user who
 *     could only forward into boxes they own could only forward to themselves.
 *  2. **Tenancy** — a target box in another organization is invisible to RLS and answers 404,
 *     never a copy filed across a tenant boundary.
 *  3. **The lamps** — a forward moves TWO mailboxes and publishes two MWI updates; a copy moves
 *     one and publishes one, because an event for the source would claim a change that did not
 *     happen.
 *  4. **Object before row** — the audio is written first and reaped when the row write throws, so
 *     a failure leaves an inert object rather than a row pointing at nothing.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const USER_ID = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const SOURCE_BOX = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const TARGET_BOX = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";
const FOREIGN_BOX = "019fd3c2-5555-76be-a6b3-b0f1914e39b6";
const MESSAGE_ID = "019fd3c2-6666-76be-a6b3-b0f1914e39b6";
const EXTENSION_ID = "019fd3c2-7777-76be-a6b3-b0f1914e39b6";

function sessionWith(permissions: readonly string[]): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER_ID,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: ORGANIZATION_ID,
			ipAddress: null,
			userAgent: "Mozilla/5.0 (test)",
		},
		user: { id: USER_ID, email: "u@test", name: "U", emailVerified: true, role: "user" },
		permissions: [...permissions],
	} as unknown as AppSession;
}

const ADMIN = sessionWith(["voicemail.write", "voicemail.read"]);
const OWNER = sessionWith(["voicemail.write.own", "voicemail.read.own"]);

interface Recorded {
	readonly inserted: Record<string, unknown>[];
	readonly audits: Record<string, unknown>[];
	readonly deletes: number;
	readonly mwi: { mailboxId: string; reason: string }[];
	readonly emails: { mailboxId: string; messageId: string }[];
	readonly puts: string[];
	readonly unlinked: string[];
}

interface Harness {
	readonly service: VoicemailMessagesService;
	readonly recorded: Recorded;
}

/**
 * A transaction that answers the four shapes this path asks for and records the two it writes.
 *
 * The chain is distinguished by how it ENDS, which is how the service's own queries differ: a box
 * read joins the extension and takes one row, the counts read groups by folder, the message read
 * takes one row without a join, and the ownership read has no terminal at all.
 */
function harness(
	options: {
		readonly boxes?: readonly string[];
		readonly ownedBoxes?: readonly string[];
		readonly missingObject?: boolean;
		readonly rowWriteFails?: boolean;
	} = {},
): Harness {
	const boxes = new Set(options.boxes ?? [SOURCE_BOX, TARGET_BOX]);
	const recorded = {
		inserted: [] as Record<string, unknown>[],
		audits: [] as Record<string, unknown>[],
		deletes: 0,
		mwi: [] as { mailboxId: string; reason: string }[],
		emails: [] as { mailboxId: string; messageId: string }[],
		puts: [] as string[],
		unlinked: [] as string[],
	};

	// The ownership read behind the `.own` narrowing: the user's extensions, then the boxes bound to
	// them. Matched on TABLE IDENTITY rather than on a name string, so a rename in the schema breaks
	// this harness instead of silently answering "you own nothing" for every case.
	const selectChain = (): Record<string, unknown> => {
		const state = { table: undefined as unknown };
		const resolve = async (): Promise<unknown[]> => {
			const owned = options.ownedBoxes ?? [];
			if (state.table === extensionUser) {
				return owned.length > 0 ? [{ extensionId: EXTENSION_ID }] : [];
			}
			if (state.table === voicemailBox) {
				return owned.map((id) => ({ id }));
			}
			return [];
		};
		const self: Record<string, unknown> = {};
		self.from = (table: unknown) => {
			state.table = table;
			return self;
		};
		self.where = () => self;
		self.then = (onOk: (value: unknown) => unknown, onErr: (reason: unknown) => unknown) =>
			resolve().then(onOk, onErr);
		return self;
	};

	// The box and message reads are answered by identity rather than by replaying Drizzle's SQL:
	// what this file is about is the ORDER of the writes and the tenancy refusal, not the rendering.
	const boxRow = (id: string) => ({
		id,
		mailboxNumber: id === SOURCE_BOX ? "2001" : "2002",
		extensionNumber: id === SOURCE_BOX ? "2001" : "2002",
		mwiEnabled: true,
	});

	let pendingBoxId: string | undefined;
	const transaction = {
		select: (columns: Record<string, unknown>) => {
			const keys = Object.keys(columns);
			if (keys.includes("mwiEnabled")) {
				const self: Record<string, unknown> = {};
				self.from = () => self;
				self.leftJoin = () => self;
				self.where = (predicate: unknown) => {
					pendingBoxId = boxIdIn(predicate);
					return self;
				};
				self.limit = async () =>
					pendingBoxId !== undefined && boxes.has(pendingBoxId) ? [boxRow(pendingBoxId)] : [];
				return self;
			}
			if (keys.includes("total")) {
				const self: Record<string, unknown> = {};
				self.from = () => self;
				self.where = () => self;
				self.groupBy = async () => [
					{ folder: "new", total: 1 },
					{ folder: "saved", total: 2 },
				];
				return self;
			}
			if (keys.includes("objectKey")) {
				const self: Record<string, unknown> = {};
				self.from = () => self;
				self.where = () => self;
				self.limit = async () => [
					{
						id: MESSAGE_ID,
						voicemailBoxId: SOURCE_BOX,
						objectKey: `${ORGANIZATION_ID}/${MESSAGE_ID}.wav`,
						folder: "new",
						callerIdName: "Alice",
						callerIdNumber: "+15005550101",
						receivedAt: new Date("2026-09-09T10:00:00.000Z"),
						durationMs: 4200,
						sizeBytes: 11,
						transcription: null,
						transcriptionStatus: "disabled",
						transcribedAt: null,
						callLegRef: null,
					},
				];
				return self;
			}
			return selectChain();
		},
		insert: (table: unknown) => ({
			values: (row: Record<string, unknown>) => {
				if (options.rowWriteFails) {
					throw new Error("the pool is gone");
				}
				if (table === auditLog) {
					recorded.audits.push(row);
				} else {
					recorded.inserted.push(row);
				}
				const self: Record<string, unknown> = {};
				self.returning = async () => [{ ...row, receivedAt: row.receivedAt as Date }];
				self.then = (onOk: (value: unknown) => unknown) => Promise.resolve(undefined).then(onOk);
				return self;
			},
		}),
		delete: () => ({
			where: () => {
				recorded.deletes += 1;
				return Promise.resolve(undefined);
			},
		}),
	};

	const database = {
		withTenantScope: async <T>(_organizationId: string, work: (t: never) => Promise<T>) =>
			await work(transaction as never),
	} as unknown as PbxDatabaseClient;

	const store = {
		head: async () => (options.missingObject ? undefined : { sizeBytes: 11 }),
		getStream: async () => Readable.from([Buffer.from("hello voice")]),
		put: async (key: string) => {
			recorded.puts.push(key);
		},
		delete: async (key: string) => {
			recorded.unlinked.push(key);
		},
	};

	const mwi = {
		publish: async (
			_organizationId: string,
			mailboxId: string,
			_number: string,
			_extension: string | undefined,
			_counts: unknown,
			reason: string,
		) => {
			recorded.mwi.push({ mailboxId, reason });
			return true;
		},
	};

	const email = {
		notify: async (_organizationId: string, mailboxId: string, messageId: string) => {
			recorded.emails.push({ mailboxId, messageId });
			return { outcome: "sent" as const };
		},
	};

	const service = new VoicemailMessagesService(
		{} as never,
		database,
		mwi as never,
		store as never,
		email as never,
	);
	return { service, recorded };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Which box id a `where` predicate names, walked out of Drizzle's own SQL object.
 *
 * A walk rather than `JSON.stringify`, because a rendered predicate holds its column, its column
 * holds its table and the table holds its columns — a cycle a serializer refuses. The only uuid
 * STRING anywhere in the graph is the bound parameter, which is what makes the first hit the answer.
 */
function boxIdIn(predicate: unknown): string | undefined {
	const seen = new Set<unknown>();
	const stack: unknown[] = [predicate];
	while (stack.length > 0) {
		const node = stack.pop();
		if (typeof node === "string" && UUID_PATTERN.test(node)) {
			return node;
		}
		if (node !== null && typeof node === "object" && !seen.has(node)) {
			seen.add(node);
			stack.push(...Object.values(node));
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// 1. What each mode does to the two mailboxes
// ---------------------------------------------------------------------------------------------

describe("forwarding a voicemail message", () => {
	it("files a copy in the target box and removes the original", async () => {
		const { service, recorded } = harness();

		const result = await service.forward(ADMIN, SOURCE_BOX, MESSAGE_ID, {
			targetVoicemailBoxId: TARGET_BOX,
			mode: "forward",
		});

		expect(recorded.inserted).to.have.lengthOf(1);
		expect(recorded.inserted[0]?.voicemailBoxId).to.equal(TARGET_BOX);
		// Always `new`: to the recipient this message has just arrived, and the folder is the lamp.
		expect(recorded.inserted[0]?.folder).to.equal("new");
		expect(recorded.deletes).to.equal(1);
		expect(result.mode).to.equal("forward");
		expect(result.data.voicemailBoxId).to.equal(TARGET_BOX);
		expect(result.mailbox.id).to.equal(TARGET_BOX);
		expect(result.source.id).to.equal(SOURCE_BOX);
	});

	it("leaves the original in place when copying", async () => {
		const { service, recorded } = harness();

		await service.forward(ADMIN, SOURCE_BOX, MESSAGE_ID, {
			targetVoicemailBoxId: TARGET_BOX,
			mode: "copy",
		});

		expect(recorded.inserted).to.have.lengthOf(1);
		expect(recorded.deletes).to.equal(0);
	});

	it("copies the audio to a NEW key under the tenant's own prefix", async () => {
		const { service, recorded } = harness();

		await service.forward(ADMIN, SOURCE_BOX, MESSAGE_ID, {
			targetVoicemailBoxId: TARGET_BOX,
			mode: "copy",
		});

		expect(recorded.puts).to.have.lengthOf(1);
		const key = recorded.puts[0] as string;
		expect(key).to.match(new RegExp(`^${ORGANIZATION_ID}/[0-9a-f-]{36}\\.wav$`, "u"));
		expect(key).to.not.equal(`${ORGANIZATION_ID}/${MESSAGE_ID}.wav`);
		// The size is what was actually read, never the source row's claim about it.
		expect(recorded.inserted[0]?.sizeBytes).to.equal(11);
	});

	it("refuses a message forwarded into the mailbox it is already in", async () => {
		const { service, recorded } = harness();

		const failure = await service
			.forward(ADMIN, SOURCE_BOX, MESSAGE_ID, {
				targetVoicemailBoxId: SOURCE_BOX,
				mode: "forward",
			})
			.catch((error: unknown) => error);

		expect((failure as { getStatus: () => number }).getStatus()).to.equal(400);
		expect(recorded.puts).to.have.lengthOf(0);
	});
});

// ---------------------------------------------------------------------------------------------
// 2. Reach and tenancy
// ---------------------------------------------------------------------------------------------

describe("who may forward a voicemail message", () => {
	it("lets a `.own` holder forward OUT of their own box and INTO one they do not own", async () => {
		// The whole point of the feature: the target is proved by tenancy, never by ownership.
		const { service, recorded } = harness({ ownedBoxes: [SOURCE_BOX] });

		await service.forward(OWNER, SOURCE_BOX, MESSAGE_ID, {
			targetVoicemailBoxId: TARGET_BOX,
			mode: "forward",
		});

		expect(recorded.inserted[0]?.voicemailBoxId).to.equal(TARGET_BOX);
	});

	it("refuses a `.own` holder forwarding out of somebody else's box", async () => {
		const { service } = harness({ ownedBoxes: [TARGET_BOX] });

		const failure = await service
			.forward(OWNER, SOURCE_BOX, MESSAGE_ID, {
				targetVoicemailBoxId: TARGET_BOX,
				mode: "forward",
			})
			.catch((error: unknown) => error);

		expect((failure as { getStatus: () => number }).getStatus()).to.equal(403);
	});

	it("answers 404 for a target box in another organization, and writes nothing", async () => {
		// RLS hides the row, so "not this tenant's" and "does not exist" are one answer — which is
		// what stops this endpoint being an oracle for another tenant's mailbox ids.
		const { service, recorded } = harness({ boxes: [SOURCE_BOX] });

		const failure = await service
			.forward(ADMIN, SOURCE_BOX, MESSAGE_ID, {
				targetVoicemailBoxId: FOREIGN_BOX,
				mode: "forward",
			})
			.catch((error: unknown) => error);

		expect((failure as { getStatus: () => number }).getStatus()).to.equal(404);
		expect(recorded.puts).to.have.lengthOf(0);
		expect(recorded.inserted).to.have.lengthOf(0);
		expect(recorded.deletes).to.equal(0);
	});
});

// ---------------------------------------------------------------------------------------------
// 3. The lamps, the ledger and the notification
// ---------------------------------------------------------------------------------------------

describe("what a forward announces", () => {
	it("publishes MWI for BOTH mailboxes on a forward", async () => {
		const { service, recorded } = harness();

		await service.forward(ADMIN, SOURCE_BOX, MESSAGE_ID, {
			targetVoicemailBoxId: TARGET_BOX,
			mode: "forward",
		});

		expect(recorded.mwi).to.deep.equal([
			{ mailboxId: TARGET_BOX, reason: "message-left" },
			{ mailboxId: SOURCE_BOX, reason: "message-deleted" },
		]);
	});

	it("publishes MWI for the TARGET only on a copy", async () => {
		// The source is untouched, and an event for it would claim a change that did not happen.
		const { service, recorded } = harness();

		await service.forward(ADMIN, SOURCE_BOX, MESSAGE_ID, {
			targetVoicemailBoxId: TARGET_BOX,
			mode: "copy",
		});

		expect(recorded.mwi).to.deep.equal([{ mailboxId: TARGET_BOX, reason: "message-left" }]);
	});

	it("writes one ledger row naming both mailboxes", async () => {
		const { service, recorded } = harness();

		await service.forward(ADMIN, SOURCE_BOX, MESSAGE_ID, {
			targetVoicemailBoxId: TARGET_BOX,
			mode: "forward",
		});

		expect(recorded.audits).to.have.lengthOf(1);
		const entry = recorded.audits[0] as Record<string, Record<string, unknown>>;
		expect(entry.action).to.equal("voicemail-message.forward");
		expect(entry.resourceType).to.equal("voicemail_message");
		expect(entry.before?.voicemailBoxId).to.equal(SOURCE_BOX);
		expect(entry.after?.voicemailBoxId).to.equal(TARGET_BOX);
	});

	it("notifies the TARGET mailbox about its new message", async () => {
		const { service, recorded } = harness();

		await service.forward(ADMIN, SOURCE_BOX, MESSAGE_ID, {
			targetVoicemailBoxId: TARGET_BOX,
			mode: "copy",
		});

		expect(recorded.emails).to.have.lengthOf(1);
		expect(recorded.emails[0]?.mailboxId).to.equal(TARGET_BOX);
		// The COPY's id, never the original's: `email_sent_at` is a per-row claim.
		expect(recorded.emails[0]?.messageId).to.not.equal(MESSAGE_ID);
	});
});

// ---------------------------------------------------------------------------------------------
// 4. Object before row
// ---------------------------------------------------------------------------------------------

describe("when the copy cannot be completed", () => {
	it("unlinks the object it wrote when the row write throws", async () => {
		const { service, recorded } = harness({ rowWriteFails: true });

		const failure = await service
			.forward(ADMIN, SOURCE_BOX, MESSAGE_ID, {
				targetVoicemailBoxId: TARGET_BOX,
				mode: "forward",
			})
			.catch((error: unknown) => error);

		expect(failure).to.be.instanceOf(Error);
		expect(recorded.puts).to.have.lengthOf(1);
		expect(recorded.unlinked).to.deep.equal(recorded.puts);
		expect(recorded.deletes).to.equal(0);
	});

	it("answers 410 when the source audio is no longer in the store", async () => {
		// A row whose media is gone is not a 404: the message existed, and saying so is what lets the
		// UI tell "no such message" from "the recording is gone".
		const { service, recorded } = harness({ missingObject: true });

		const failure = await service
			.forward(ADMIN, SOURCE_BOX, MESSAGE_ID, {
				targetVoicemailBoxId: TARGET_BOX,
				mode: "forward",
			})
			.catch((error: unknown) => error);

		expect((failure as { getStatus: () => number }).getStatus()).to.equal(410);
		expect(recorded.puts).to.have.lengthOf(0);
		expect(recorded.inserted).to.have.lengthOf(0);
	});
});
