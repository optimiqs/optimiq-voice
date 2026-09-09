import { expect } from "chai";
import { PromptsService } from "../../src/pbx/prompts/prompts.service";
import { VoicemailGreetingsService } from "../../src/pbx/voicemail-boxes/voicemail-greetings.service";
import type { MultipartRequest } from "../../src/pbx/media/media-upload";
import type { OrgLimitsService } from "../../src/pbx/org-limits/org-limits.service";
import type { ObjectStore } from "../../src/storage";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * `maxStorageMb` is only as real as its call sites.
 *
 * The limit is measured by summing the bytes already stored, and the only moment a tenant can be
 * refused is the upload — after the multipart read (the size is not knowable before it) and BEFORE
 * the object is written, because an object that lands in the store has already cost the storage the
 * limit exists to bound. The branding logo path had that gate; the two audio upload paths did not,
 * so an organization capped at 100 MB could put a gigabyte of prompts and greetings on the volume.
 *
 * These assert the ORDER as much as the check: a refusal must leave the store untouched.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const USER = "019fd3c2-9999-76be-a6b3-b0f1914e39b6";
const BOX = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";

const ENV = { PBX_MEDIA_MAX_UPLOAD_BYTES: 10_000_000 } as never;

/** A minimal RIFF/WAVE 8 kHz mono 16-bit PCM file — the one format every deployment can play. */
function wav(samples: number): Buffer {
	const data = Buffer.alloc(samples * 2);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "latin1");
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8, "latin1");
	header.write("fmt ", 12, "latin1");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(8000, 24);
	header.writeUInt32LE(16_000, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "latin1");
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

function multipart(bytes: Buffer): MultipartRequest {
	return {
		isMultipart: () => true,
		parts: async function* () {
			yield {
				type: "file" as const,
				fieldname: "file",
				filename: "greeting.wav",
				mimetype: "audio/wav",
				file: (async function* () {
					yield bytes;
				})(),
			};
		},
	} as unknown as MultipartRequest;
}

function sessionFor(): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: ORG,
		},
		user: { id: USER, email: "u@test", name: "U", emailVerified: true },
	} as AppSession;
}

/** A store that records writes, so "refused before the object landed" is observable. */
function fakeStore(): ObjectStore & { readonly puts: string[] } {
	const puts: string[] = [];
	return {
		puts,
		put: async (objectKey: string) => {
			puts.push(objectKey);
		},
		delete: async () => undefined,
	} as unknown as ObjectStore & { readonly puts: string[] };
}

/** A limits gate that records the byte count it was asked about and can refuse. */
function fakeLimits(refuse: boolean): OrgLimitsService & { readonly asked: number[] } {
	const asked: number[] = [];
	return {
		asked,
		assertMayStore: async (_session: AppSession, incomingBytes: number) => {
			asked.push(incomingBytes);
			await Promise.resolve();
			if (refuse) {
				throw new Error("over quota");
			}
		},
	} as unknown as OrgLimitsService & { readonly asked: number[] };
}

/** A database whose tenant-scoped selects find whatever the caller asked for. */
function fakeDatabase(rows: readonly unknown[]): PbxDatabaseClient {
	const chain = (): Record<string, unknown> => {
		const self: Record<string, unknown> = {};
		self.from = () => self;
		self.leftJoin = () => self;
		self.where = () => self;
		self.limit = async () => [...rows];
		return self;
	};
	return {
		withTenantScope: async <T>(_organizationId: string, work: (t: never) => Promise<T>) =>
			await work({ select: () => chain() } as never),
	} as unknown as PbxDatabaseClient;
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
		return undefined;
	} catch (error) {
		return error;
	}
}

describe("the storage quota on audio uploads", () => {
	it("refuses a prompt over the tenant's ceiling before a byte reaches the store", async () => {
		const store = fakeStore();
		const limits = fakeLimits(true);
		const service = new PromptsService(
			ENV,
			fakeDatabase([]),
			{} as never,
			store,
			limits as OrgLimitsService,
		);

		const error = await caught(async () => {
			await service.upload(sessionFor(), multipart(wav(400)));
		});

		expect(error).to.be.instanceOf(Error);
		expect(limits.asked).to.have.lengthOf(1);
		expect(limits.asked[0]).to.equal(844);
		expect(store.puts).to.deep.equal([]);
	});

	it("refuses a voicemail greeting the same way, and asks about the same byte count", async () => {
		const store = fakeStore();
		const limits = fakeLimits(true);
		const service = new VoicemailGreetingsService(
			ENV,
			fakeDatabase([{ id: BOX }]),
			{} as never,
			store,
			limits as OrgLimitsService,
		);

		const error = await caught(async () => {
			await service.upload(sessionFor(), BOX, multipart(wav(400)));
		});

		expect(error).to.be.instanceOf(Error);
		expect(limits.asked).to.deep.equal([844]);
		expect(store.puts).to.deep.equal([]);
	});
});
