import { Readable } from "node:stream";
import { expect } from "chai";
import { FileGreetingRpcController } from "../../src/pbx/voicemail-boxes/file-greeting-rpc.controller";
import { FileGreetingService } from "../../src/pbx/voicemail-boxes/file-greeting.service";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { VoicemailGreetingsService } from "../../src/pbx/voicemail-boxes/voicemail-greetings.service";
import type { ObjectStat, ObjectStore } from "../../src/storage";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * `rpc.pbx.v1.file-greeting` — the responder behind `*99`.
 *
 * The second write the engine makes, and the first that carries an OBJECT KEY. What a first
 * responder can get wrong, none of which needs a database or a filesystem:
 *
 *  1. **The mailbox claim.** An unknown box, a disabled box and a box whose number is not the
 *     claimed one must all be refused, and refused identically — the handset is never told which,
 *     because the difference is how a tenant's mailboxes would be enumerated over a phone line.
 *  2. **The object claim.** A key outside the requesting organization's own prefix is a
 *     cross-tenant read with a playback route attached to it, and it must be refused before the
 *     store is asked to open anything.
 *  3. **The bytes are audio.** A key that names nothing, an empty object, or a file that is not
 *     audio must not become an ACTIVE greeting: a mailbox that plays silence has stopped announcing
 *     itself and says nothing about why.
 *  4. **Nothing throws.** Every failure — including a rolled-back compile — comes back as
 *     `applied: false`, because somebody has just recorded thirty seconds of their voice and would
 *     take silence for success.
 *
 * The write itself is `VoicemailGreetingsService.fileRecordedGreeting`, which is the SAME method
 * the admin UI's upload reaches: that it deactivates the incumbent, recompiles inside the
 * transaction and unlinks the object when the transaction does not commit is that service's
 * subject. What is asserted here is that this responder goes through it rather than around it, and
 * with which values.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORG = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const BOX = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const GREETING = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";
const CALL = "019fd3c2-5555-76be-a6b3-b0f1914e39b6";
const KEY = `${ORG}/${CALL}/rec-1.wav`;

const ENV = { PBX_MEDIA_MAX_UPLOAD_BYTES: 10_000_000 } as PbxEnv;

/** A minimal 16-bit PCM WAV header, which is what `probeAudio` sniffs for. */
function wavBytes(payloadBytes = 320): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "latin1");
	header.writeUInt32LE(36 + payloadBytes, 4);
	header.write("WAVE", 8, "latin1");
	header.write("fmt ", 12, "latin1");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(8_000, 24);
	header.writeUInt32LE(16_000, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "latin1");
	header.writeUInt32LE(payloadBytes, 40);
	return Buffer.concat([header, Buffer.alloc(payloadBytes)]);
}

interface BoxRow {
	readonly mailboxNumber: string;
	readonly enabled: boolean;
}

/**
 * A database that hands back one box row and remembers the tenant it was scoped to.
 *
 * Faked at `withTenantScope` rather than per-query, on the same terms as
 * `extensionFeatureRpc.test.ts`: the service issues one read, and asserting on its SQL would be
 * asserting on Drizzle. The tenancy claim these specs make is about the ARGUMENT — RLS is what
 * filters, so proving the right organization was scoped is proving the filter was right.
 */
function fakeDatabase(row: BoxRow | undefined): {
	database: PbxDatabaseClient;
	scopes: string[];
} {
	const scopes: string[] = [];
	const transaction = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => (row === undefined ? [] : [row]),
				}),
			}),
		}),
	};
	const database = {
		withTenantScope: async <T>(
			organizationId: string,
			work: (tx: never) => Promise<T>,
		): Promise<T> => {
			scopes.push(organizationId);
			return await work(transaction as never);
		},
	} as unknown as PbxDatabaseClient;
	return { database, scopes };
}

/** A recordings store holding one object, and remembering every key it was asked for. */
function fakeStore(objects: Readonly<Record<string, Buffer>>): {
	store: ObjectStore;
	reads: string[];
} {
	const reads: string[] = [];
	const store = {
		driver: "local" as const,
		head: async (objectKey: string): Promise<ObjectStat | undefined> => {
			reads.push(objectKey);
			const bytes = objects[objectKey];
			return bytes === undefined ? undefined : { sizeBytes: bytes.length };
		},
		getStream: async (objectKey: string): Promise<Readable> => {
			const bytes = objects[objectKey];
			if (bytes === undefined) {
				throw new Error(`no such object ${objectKey}`);
			}
			return Readable.from([bytes]);
		},
	} as unknown as ObjectStore;
	return { store, reads };
}

interface RecordedFiling {
	readonly organizationId: string;
	readonly boxId: string;
	readonly greetingId: string;
	readonly kind: string;
	readonly label: string;
	readonly durationMs: number;
	readonly bytes: number;
	readonly extension: string;
}

/** A greetings service whose filing is recorded rather than performed. */
function fakeGreetings(behaviour: "succeeds" | "fails" = "succeeds"): {
	greetings: VoicemailGreetingsService;
	filings: RecordedFiling[];
} {
	const filings: RecordedFiling[] = [];
	const greetings = {
		fileRecordedGreeting: async (input: {
			organizationId: string;
			boxId: string;
			greetingId: string;
			kind: string;
			label: string;
			durationMs: number;
			audio: { bytes: Buffer; extension: string };
		}) => {
			filings.push({
				organizationId: input.organizationId,
				boxId: input.boxId,
				greetingId: input.greetingId,
				kind: input.kind,
				label: input.label,
				durationMs: input.durationMs,
				bytes: input.audio.bytes.length,
				extension: input.audio.extension,
			});
			if (behaviour === "fails") {
				throw new Error("the artifact would be unsound");
			}
			return {
				row: { id: input.greetingId },
				objectKey: `greetings/${input.organizationId}/${input.boxId}/${input.greetingId}.wav`,
			};
		},
	} as unknown as VoicemailGreetingsService;
	return { greetings, filings };
}

function serviceFor(
	options: {
		readonly box?: BoxRow | undefined;
		readonly objects?: Readonly<Record<string, Buffer>>;
		readonly filing?: "succeeds" | "fails";
	} = {},
) {
	const { database, scopes } = fakeDatabase(
		options.box === undefined && !("box" in options)
			? { mailboxNumber: "1001", enabled: true }
			: options.box,
	);
	const { store, reads } = fakeStore(options.objects ?? { [KEY]: wavBytes() });
	const { greetings, filings } = fakeGreetings(options.filing ?? "succeeds");
	return {
		service: new FileGreetingService(ENV, database, store, greetings),
		scopes,
		reads,
		filings,
	};
}

const REQUEST = {
	orgId: ORG,
	voicemailBoxId: BOX,
	mailboxNumber: "1001",
	greetingId: GREETING,
	kind: "unavailable" as const,
	objectKey: KEY,
	durationMs: 4_200,
};

describe("FileGreetingService", () => {
	describe("resolving the claimed mailbox", () => {
		it("resolves the box inside the request's own tenant scope", async () => {
			const { service, scopes } = serviceFor();
			await service.fileForBroker(REQUEST);
			expect(scopes).to.deep.equal([ORG]);
		});

		it("files the greeting through the same service the admin upload uses", async () => {
			const { service, filings } = serviceFor();
			const reply = await service.fileForBroker(REQUEST);

			expect(reply.applied).to.equal(true);
			// `active` is the second field for a reason: a greeting that was stored and not activated
			// would be a confirmation tone for a recording nobody will ever hear.
			expect(reply.active).to.equal(true);
			expect(reply.greetingId).to.equal(GREETING);
			expect(reply.objectKey).to.equal(`greetings/${ORG}/${BOX}/${GREETING}.wav`);
			expect(filings).to.have.length(1);
			expect(filings[0]).to.include({
				organizationId: ORG,
				boxId: BOX,
				// The engine's id becomes the ROW id, which is what makes a retried request file one
				// greeting rather than two rows racing for the single active slot.
				greetingId: GREETING,
				kind: "unavailable",
				durationMs: 4_200,
				extension: "wav",
			});
		});

		it("refuses an unknown box without reading any audio", async () => {
			const { service, reads, filings } = serviceFor({ box: undefined });
			const reply = await service.fileForBroker(REQUEST);

			expect(reply.applied).to.equal(false);
			expect(reply.reason).to.contain("no enabled mailbox 1001");
			expect(reads).to.have.length(0);
			expect(filings).to.have.length(0);
		});

		it("refuses a DISABLED box the same way it refuses an unknown one", async () => {
			const { service, filings } = serviceFor({ box: { mailboxNumber: "1001", enabled: false } });
			const reply = await service.fileForBroker(REQUEST);

			expect(reply.applied).to.equal(false);
			expect(reply.reason).to.contain("no enabled mailbox 1001");
			expect(filings).to.have.length(0);
		});

		it("refuses a box whose number is not the one claimed", async () => {
			// The cross-check the contract asks for: a box id is a lookup key, and pairing it with the
			// number the walk authenticated is what stops a request replacing a mailbox the caller has
			// never been challenged for.
			const { service, filings } = serviceFor({ box: { mailboxNumber: "1002", enabled: true } });
			const reply = await service.fileForBroker(REQUEST);

			expect(reply.applied).to.equal(false);
			expect(filings).to.have.length(0);
		});
	});

	describe("the object key is a claim too", () => {
		it("refuses a key belonging to another organization, before opening anything", async () => {
			const foreign = `${OTHER_ORG}/${CALL}/rec-1.wav`;
			const { service, reads, filings } = serviceFor({ objects: { [foreign]: wavBytes() } });
			const reply = await service.fileForBroker({ ...REQUEST, objectKey: foreign });

			expect(reply.applied).to.equal(false);
			expect(reply.reason).to.contain("does not belong to this organization");
			// Never opened: a refusal that had to stat the object first would be a cross-tenant probe
			// even when it refused.
			expect(reads).to.have.length(0);
			expect(filings).to.have.length(0);
		});

		it("refuses a traversal out of the recordings root", async () => {
			const { service, reads } = serviceFor();
			const reply = await service.fileForBroker({
				...REQUEST,
				objectKey: "../../etc/passwd",
			});

			expect(reply.applied).to.equal(false);
			expect(reads).to.have.length(0);
		});

		it("refuses a key that names nothing", async () => {
			const { service, filings } = serviceFor({ objects: {} });
			const reply = await service.fileForBroker(REQUEST);

			expect(reply.applied).to.equal(false);
			expect(reply.reason).to.contain("no recording under that key");
			expect(filings).to.have.length(0);
		});

		it("refuses an object that is not audio rather than filing silence", async () => {
			// The same sniffer the multipart upload runs, and for the same reason: a `.wav` extension
			// is a claim about a file's name, not about its contents.
			const { service, filings } = serviceFor({
				objects: { [KEY]: Buffer.from("this is not a wav file at all") },
			});
			const reply = await service.fileForBroker(REQUEST);

			expect(reply.applied).to.equal(false);
			expect(filings).to.have.length(0);
		});

		it("refuses an empty object", async () => {
			const { service, filings } = serviceFor({ objects: { [KEY]: Buffer.alloc(0) } });
			const reply = await service.fileForBroker(REQUEST);

			expect(reply.applied).to.equal(false);
			expect(reply.reason).to.contain("empty");
			expect(filings).to.have.length(0);
		});
	});

	describe("failures answer rather than throw", () => {
		it("turns a rolled-back write into applied:false", async () => {
			const { service } = serviceFor({ filing: "fails" });
			const reply = await service.fileForBroker(REQUEST);

			expect(reply.applied).to.equal(false);
			expect(reply.active).to.equal(false);
			expect(reply.reason).to.contain("the artifact would be unsound");
		});
	});
});

describe("FileGreetingRpcController", () => {
	it("answers a malformed request instead of letting it time out", async () => {
		const controller = new FileGreetingRpcController({
			fileForBroker: async () => {
				throw new Error("the service must not be reached");
			},
		} as unknown as FileGreetingService);

		const reply = await controller.file({ orgId: "not-a-uuid", kind: "temporary" });

		expect(reply.applied).to.equal(false);
		// The slot is read off the raw payload so a support log correlates with the code somebody
		// pressed, even when the rest of the request did not survive parsing.
		expect(reply.kind).to.equal("temporary");
		expect(reply.reason).to.contain("orgId");
	});

	it("refuses a greeting with no audio in it, at the schema", async () => {
		// The floor the walk already applies, restated on the wire: an ACTIVE greeting containing
		// silence stops a mailbox announcing itself and says nothing about why.
		const controller = new FileGreetingRpcController({
			fileForBroker: async () => {
				throw new Error("the service must not be reached");
			},
		} as unknown as FileGreetingService);

		const reply = await controller.file({ ...REQUEST, durationMs: 0 });

		expect(reply.applied).to.equal(false);
		expect(reply.reason).to.contain("durationMs");
	});

	it("catches a throwing service, because a broker timeout is dead air on a live call", async () => {
		const controller = new FileGreetingRpcController({
			fileForBroker: async () => {
				throw new Error("the pool is exhausted");
			},
		} as unknown as FileGreetingService);

		const reply = await controller.file(REQUEST);

		expect(reply.applied).to.equal(false);
		expect(reply.reason).to.contain("the pool is exhausted");
	});
});
