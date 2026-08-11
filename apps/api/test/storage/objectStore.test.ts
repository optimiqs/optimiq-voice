import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { expect } from "chai";
import { openMediaResponse } from "../../src/media/media-response";
import {
	assertStoragePreflight,
	createObjectStore,
	isArchivingObjectStore,
	isS3Configured,
	LocalObjectStore,
	loadStorageEnv,
	MirroredObjectStore,
	ObjectKeyOutsideRootError,
	ObjectNotFoundError,
	S3ObjectStore,
	StorageConfigurationFailure,
} from "../../src/storage";
import type { StorageEnv } from "../../src/storage";
import type { S3Client } from "@aws-sdk/client-s3";

/**
 * The object-store seam, tested without a socket and without a bucket.
 *
 * Four things are worth testing here and they are the four this file is organised around:
 *
 * 1. **Driver selection.** Which store an environment gets, and which environments are refused. The
 *    default has to stay `local`, because the shipped `compose.yaml` has no object-store service and
 *    a deployment that has never heard of this module must keep working unchanged.
 * 2. **Local-driver parity.** The paths, the ranges and the absence semantics the API had before the
 *    seam existed. This is the one that matters most and it is not obvious why until you read
 *    `src/storage/object-store.ts`: **Asterisk opens these files off a bind mount**, so a driver
 *    that moved a byte would turn every tenant's prompts into silence on a call without failing
 *    anything else in this repository.
 * 3. **The S3 driver**, against an in-process fake that answers the four commands the store sends.
 *    A manual stub rather than `aws-sdk-client-mock`: the surface is four commands, the assertions
 *    that matter are about the REQUEST this store builds (the bucket key, the `Range` header, the
 *    explicit `ContentLength`), and a mocking library would hide exactly those behind matchers.
 * 4. **The mirror**, which is where the Asterisk constraint is written as code: filesystem first on
 *    every read, both halves on a write, and an `archiveObject` that copies volume → bucket.
 *
 * The one thing NOT tested here is a real MinIO round trip; `.scripts` has no harness for it and the
 * fake covers the request shapes. `compose.dev.yaml` ships a `minio` service so it can be done by
 * hand: see `.env.example.dev`.
 */

const S3_ENV: StorageEnv = {
	driver: "s3",
	bucket: "optimiq-media",
	region: "us-east-1",
	endpoint: "http://minio:9000",
	accessKeyId: "minioadmin",
	secretAccessKey: "minioadmin",
	forcePathStyle: true,
	prefix: "",
	timeoutMs: 30_000,
};

// ---------------------------------------------------------------------------------------------
// 1. The environment contract and driver selection
// ---------------------------------------------------------------------------------------------

describe("storage environment", () => {
	it("defaults to the local driver, so an environment that has never heard of this keeps working", () => {
		const env = loadStorageEnv({});
		expect(env.driver).to.equal("local");
		expect(env.bucket).to.equal(undefined);
		expect(isS3Configured(env)).to.equal(false);
	});

	it("treats an unknown driver as local rather than as a boot failure", () => {
		// An orchestrator that templates the value from a variable it did not set produces garbage,
		// and the safe reading of garbage is "the default" — which is the filesystem that is already
		// mounted, not a bucket nobody configured.
		expect(loadStorageEnv({ STORAGE_DRIVER: "gcs" }).driver).to.equal("local");
		expect(loadStorageEnv({ STORAGE_DRIVER: "" }).driver).to.equal("local");
	});

	it("refuses STORAGE_DRIVER=s3 with no bucket, at parse time", () => {
		expect(() => loadStorageEnv({ STORAGE_DRIVER: "s3" })).to.throw(/S3_BUCKET/u);
	});

	it("refuses a half-set credential pair in either direction", () => {
		expect(() =>
			loadStorageEnv({ STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k" }),
		).to.throw(/S3_SECRET_ACCESS_KEY/u);
		expect(() =>
			loadStorageEnv({ STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_SECRET_ACCESS_KEY: "s" }),
		).to.throw(/S3_ACCESS_KEY_ID/u);
	});

	it("leaves both credentials unset so the SDK's default chain can run", () => {
		const env = loadStorageEnv({ STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_REGION: "us-east-1" });
		expect(env.accessKeyId).to.equal(undefined);
		expect(env.secretAccessKey).to.equal(undefined);
		expect(isS3Configured(env)).to.equal(true);
	});

	it("derives path-style addressing from a custom endpoint, and lets it be overridden", () => {
		const minio = loadStorageEnv({
			STORAGE_DRIVER: "s3",
			S3_BUCKET: "b",
			S3_ENDPOINT: "http://minio:9000/",
		});
		expect(minio.forcePathStyle).to.equal(true);
		// The trailing slash is stripped: the SDK appends its own, and `//bucket` is a different URL.
		expect(minio.endpoint).to.equal("http://minio:9000");

		expect(loadStorageEnv({ STORAGE_DRIVER: "s3", S3_BUCKET: "b" }).forcePathStyle).to.equal(false);
		expect(
			loadStorageEnv({
				STORAGE_DRIVER: "s3",
				S3_BUCKET: "b",
				S3_ENDPOINT: "http://minio:9000",
				S3_FORCE_PATH_STYLE: "false",
			}).forcePathStyle,
		).to.equal(false);
	});

	it("normalizes every spelling of a prefix to one form", () => {
		const of = (S3_PREFIX: string): string =>
			loadStorageEnv({ STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_PREFIX }).prefix;
		expect(of("staging")).to.equal("staging/");
		expect(of("/staging/")).to.equal("staging/");
		expect(of("")).to.equal("");
	});

	it("refuses to boot a production process that selected s3 and did not finish configuring it", () => {
		const partial = loadStorageEnv({ STORAGE_DRIVER: "s3", S3_BUCKET: "b" });
		expect(() => {
			assertStoragePreflight(partial, "production");
		}).to.throw(StorageConfigurationFailure, /S3_REGION/u);
		// Outside production the same environment boots: a developer pointing at a local MinIO
		// without a region set gets a warning-free start and a store that works.
		expect(() => {
			assertStoragePreflight(partial, "development");
		}).to.not.throw();
	});

	it("never refuses the local driver, in any environment", () => {
		expect(() => {
			assertStoragePreflight(loadStorageEnv({}), "production");
		}).to.not.throw();
	});
});

describe("storage driver selection", () => {
	it("builds a bare local store when the driver is local", () => {
		const store = createObjectStore(loadStorageEnv({}), { root: "/opt/media" });
		expect(store).to.be.instanceOf(LocalObjectStore);
		expect(store.driver).to.equal("local");
		expect(isArchivingObjectStore(store)).to.equal(false);
		expect(store.filesystemPath("prompts/a/b.wav")).to.equal("/opt/media/prompts/a/b.wav");
	});

	it("builds a MIRROR, never a bare bucket store, when the driver is s3", () => {
		// The Asterisk constraint expressed as the absence of a code path: there is no configuration
		// that makes this API stop writing prompts and hold music onto the shared volume, because
		// `sound:<root>/<key>` is the only media vocabulary ARI has. See object-store.factory.ts.
		const store = createObjectStore(S3_ENV, { root: "/opt/media" });
		expect(store).to.be.instanceOf(MirroredObjectStore);
		expect(store.driver).to.equal("mirrored");
		expect(isArchivingObjectStore(store)).to.equal(true);
		expect(store.filesystemPath("prompts/a/b.wav")).to.equal("/opt/media/prompts/a/b.wav");
	});
});

// ---------------------------------------------------------------------------------------------
// 2. The local driver — parity with what the API did before the seam
// ---------------------------------------------------------------------------------------------

describe("the local object store", () => {
	let root: string;
	let store: LocalObjectStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "optimiq-store-"));
		store = new LocalObjectStore(root);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("writes an object at exactly the path the engine will hand Asterisk", async () => {
		const key = "prompts/11111111-1111-7111-8111-111111111111/22222222.wav";
		await store.put(key, Buffer.from("RIFFwave"));
		// The literal path, not `store.filesystemPath(key)`: this assertion is the one that fails if
		// the driver ever starts hashing, prefixing or otherwise relocating a key.
		expect(await readFile(join(root, key), "utf8")).to.equal("RIFFwave");
	});

	it("creates the intermediate directories, as writeMediaObject did", async () => {
		await store.put("moh/org/class/file.wav", Buffer.from("x"));
		expect((await stat(join(root, "moh/org/class"))).isDirectory()).to.equal(true);
	});

	it("answers a size for a regular file and undefined for everything else", async () => {
		await store.put("a/b.wav", Buffer.alloc(1234));
		expect((await store.head("a/b.wav"))?.sizeBytes).to.equal(1234);
		expect(await store.exists("a/b.wav")).to.equal(true);

		expect(await store.head("a/missing.wav")).to.equal(undefined);
		expect(await store.exists("a/missing.wav")).to.equal(false);
		// A directory is not an object: streaming one would hang a response rather than 410 it.
		expect(await store.head("a")).to.equal(undefined);
	});

	it("streams the whole object, and one inclusive range", async () => {
		await store.put("a/b.wav", Buffer.from("0123456789"));
		expect(await drain(await store.getStream("a/b.wav"))).to.equal("0123456789");
		// Inclusive at both ends — the same arithmetic `http-range.ts` decides, so an off-by-one here
		// is an off-by-one in every `206` the API serves.
		expect(await drain(await store.getStream("a/b.wav", { start: 2, end: 5 }))).to.equal("2345");
	});

	it("rejects getStream for an absent object rather than emitting an error event", async () => {
		// A rejected promise is something the caller can turn into a 410. An `error` event on a
		// stream already handed to Fastify is a truncated body under a 200.
		await expectRejection(store.getStream("a/missing.wav"), ObjectNotFoundError);
	});

	it("treats a delete of an absent object as the success it is", async () => {
		await store.delete("a/never-existed.wav");
	});

	it("refuses every operation on a key that escapes the root", async () => {
		const escapes = ["../outside.wav", "a/../../outside.wav", "/etc/passwd/../../outside.wav"];
		for (const key of escapes) {
			expect(store.filesystemPath(key), key).to.equal(undefined);
			await expectRejection(store.head(key), ObjectKeyOutsideRootError);
			await expectRejection(store.getStream(key), ObjectKeyOutsideRootError);
			await expectRejection(store.put(key, Buffer.from("x")), ObjectKeyOutsideRootError);
			// `exists` answers false rather than throwing, and `delete` is a silent no-op: both are
			// called on cleanup paths where a malformed key must not turn a request that already
			// succeeded into a 500.
			expect(await store.exists(key), key).to.equal(false);
			await store.delete(key);
		}
		// And nothing was created outside the root by any of that.
		expect(await store.head("outside.wav")).to.equal(undefined);
	});

	it("does not mistake a sibling directory with a shared prefix for containment", () => {
		// The classic off-by-one in this check: a bare `startsWith(root)` accepts `<root>-evil/x`,
		// which is a DIFFERENT directory whose name happens to begin with the root's. The separator
		// is what makes the comparison correct, and this is the assertion that proves it is there.
		const evil = new LocalObjectStore(`${root}-evil`);
		expect(evil.filesystemPath("x.wav")).to.equal(join(`${root}-evil`, "x.wav"));
		expect(store.filesystemPath(`../${basename(root)}-evil/x.wav`)).to.equal(undefined);
	});

	it("cannot mint a URL, and says so rather than inventing a file:// one", async () => {
		expect(await store.presign("a/b.wav", 300)).to.equal(undefined);
	});

	it("serves a Range request through openMediaResponse exactly as the old path did", async () => {
		await store.put("a/b.wav", Buffer.from("0123456789"));
		const partial = await openMediaResponse(store, "a/b.wav", 10, {
			contentType: "audio/wav",
			fileName: "b.wav",
			rangeHeader: "bytes=2-5",
		});
		expect(partial.status).to.equal(206);
		expect(partial.headers["content-range"]).to.equal("bytes 2-5/10");
		expect(partial.headers["content-length"]).to.equal("4");
		expect(partial.headers["accept-ranges"]).to.equal("bytes");
		expect(await drain(partial.stream as Readable)).to.equal("2345");

		const whole = await openMediaResponse(store, "a/b.wav", 10, {
			contentType: "audio/wav",
			fileName: "b.wav",
		});
		expect(whole.status).to.equal(200);
		expect(whole.headers["content-length"]).to.equal("10");

		// A range past the end never reaches the store at all: 416 is decided from the size alone.
		const past = await openMediaResponse(store, "a/never-opened.wav", 10, {
			contentType: "audio/wav",
			fileName: "b.wav",
			rangeHeader: "bytes=50-60",
		});
		expect(past.status).to.equal(416);
		expect(past.stream).to.equal(undefined);
	});
});

// ---------------------------------------------------------------------------------------------
// 3. The S3 driver, against an in-process fake
// ---------------------------------------------------------------------------------------------

describe("the S3 object store", () => {
	it("builds the request the store is supposed to build", async () => {
		const fake = new FakeS3();
		const store = s3With(fake);

		await store.put("a/b.wav", Buffer.from("hello"), { contentType: "audio/wav" });
		const put = fake.lastOf("PutObjectCommand");
		expect(put.Bucket).to.equal("optimiq-media");
		expect(put.Key).to.equal("a/b.wav");
		expect(put.ContentType).to.equal("audio/wav");
		// Explicit, because several S3-compatible stores reject the chunked encoding the SDK falls
		// back to without it.
		expect(put.ContentLength).to.equal(5);
	});

	it("prefixes keys when a prefix is configured, and only then", () => {
		expect(s3With(new FakeS3()).bucketKey("a/b.wav")).to.equal("a/b.wav");
		expect(
			new S3ObjectStore({ ...S3_ENV, prefix: "staging/" }, async () =>
				new FakeS3().asClient(),
			).bucketKey("a/b.wav"),
		).to.equal("staging/a/b.wav");
	});

	it("round-trips an object", async () => {
		const store = s3With(new FakeS3());
		await store.put("a/b.wav", Buffer.from("0123456789"));
		expect((await store.head("a/b.wav"))?.sizeBytes).to.equal(10);
		expect(await store.exists("a/b.wav")).to.equal(true);
		expect(await drain(await store.getStream("a/b.wav"))).to.equal("0123456789");
	});

	it("pushes the range onto the request rather than slicing locally", async () => {
		const fake = new FakeS3();
		const store = s3With(fake);
		await store.put("a/b.wav", Buffer.from("0123456789"));
		expect(await drain(await store.getStream("a/b.wav", { start: 2, end: 5 }))).to.equal("2345");
		// The assertion that matters: the bytes were selected by the STORE, so a scrub-bar drag on an
		// hour of audio does not download an hour of audio.
		expect(fake.lastOf("GetObjectCommand").Range).to.equal("bytes=2-5");
	});

	it("answers undefined for a missing object and throws for a missing stream", async () => {
		const store = s3With(new FakeS3());
		expect(await store.head("a/missing.wav")).to.equal(undefined);
		expect(await store.exists("a/missing.wav")).to.equal(false);
		await expectRejection(store.getStream("a/missing.wav"), ObjectNotFoundError);
	});

	it("recognises a 404 with no error name, which is what several S3-compatible stores send", async () => {
		const fake = new FakeS3();
		fake.notFoundStyle = "status-only";
		const store = s3With(fake);
		expect(await store.head("a/missing.wav")).to.equal(undefined);
	});

	it("lets a real transport failure through instead of reporting it as absence", async () => {
		const fake = new FakeS3();
		fake.failWith = Object.assign(new Error("connection refused"), { name: "TimeoutError" });
		const store = s3With(fake);
		await expectRejection(store.head("a/b.wav"), Error, /connection refused/u);
	});

	it("has no filesystem path, which is the whole reason Asterisk cannot be pointed at it", () => {
		expect(s3With(new FakeS3()).filesystemPath("a/b.wav")).to.equal(undefined);
	});

	it("deletes idempotently", async () => {
		const fake = new FakeS3();
		const store = s3With(fake);
		await store.put("a/b.wav", Buffer.from("x"));
		await store.delete("a/b.wav");
		await store.delete("a/b.wav");
		expect(await store.exists("a/b.wav")).to.equal(false);
		expect(fake.commands.filter((entry) => entry.name === "DeleteObjectCommand")).to.have.length(2);
	});
});

// ---------------------------------------------------------------------------------------------
// 4. The mirror — the Asterisk constraint, written as code
// ---------------------------------------------------------------------------------------------

describe("the mirrored object store", () => {
	let root: string;
	let origin: LocalObjectStore;
	let fake: FakeS3;
	let store: MirroredObjectStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "optimiq-mirror-"));
		origin = new LocalObjectStore(root);
		fake = new FakeS3();
		store = new MirroredObjectStore(origin, s3With(fake));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("writes to the filesystem FIRST, because Asterisk has to be able to open it", async () => {
		await store.put("prompts/o/p.wav", Buffer.from("RIFF"), { contentType: "audio/wav" });
		expect(await readFile(join(root, "prompts/o/p.wav"), "utf8")).to.equal("RIFF");
		expect(fake.body("prompts/o/p.wav")).to.equal("RIFF");
		expect(fake.commands[0]?.name).to.equal("PutObjectCommand");
	});

	it("still succeeds when the mirror is down, because the object is on the volume", async () => {
		fake.failWith = new Error("bucket unreachable");
		await store.put("prompts/o/p.wav", Buffer.from("RIFF"));
		expect(await readFile(join(root, "prompts/o/p.wav"), "utf8")).to.equal("RIFF");
	});

	it("reads the filesystem when it has the object", async () => {
		await origin.put("a/b.wav", Buffer.from("local"));
		fake.put("a/b.wav", Buffer.from("mirror"));
		expect(await drain(await store.getStream("a/b.wav"))).to.equal("local");
		expect((await store.head("a/b.wav"))?.sizeBytes).to.equal(5);
	});

	it("falls back to the mirror when the volume was replaced — the audit's finding, closed", async () => {
		fake.put("recordings/o/c/r.wav", Buffer.from("archived"));
		expect((await store.head("recordings/o/c/r.wav"))?.sizeBytes).to.equal(8);
		expect(await drain(await store.getStream("recordings/o/c/r.wav"))).to.equal("archived");
		expect(
			await drain(await store.getStream("recordings/o/c/r.wav", { start: 0, end: 3 })),
		).to.equal("arch");
	});

	it("propagates a containment refusal instead of asking the bucket for an escaping key", async () => {
		await expectRejection(store.head("../outside.wav"), ObjectKeyOutsideRootError);
		expect(fake.commands).to.have.length(0);
	});

	it("archives an object Asterisk wrote, and is idempotent about it", async () => {
		await origin.put("recordings/o/c/r.wav", Buffer.from("call audio"));
		expect(await store.archiveObject("recordings/o/c/r.wav")).to.equal(true);
		expect(fake.body("recordings/o/c/r.wav")).to.equal("call audio");

		const puts = fake.commands.filter((entry) => entry.name === "PutObjectCommand").length;
		// A durable consumer redelivers; a second archive must cost one HEAD and no upload.
		expect(await store.archiveObject("recordings/o/c/r.wav")).to.equal(true);
		expect(fake.commands.filter((entry) => entry.name === "PutObjectCommand")).to.have.length(puts);
	});

	it("answers false — not an exception — when there is nothing on the volume to archive", async () => {
		expect(await store.archiveObject("recordings/o/c/never.wav")).to.equal(false);
	});

	it("throws when the archive's transport fails, so the consumer's redelivery can retry", async () => {
		await origin.put("recordings/o/c/r.wav", Buffer.from("call audio"));
		fake.failWith = new Error("bucket unreachable");
		await expectRejection(store.archiveObject("recordings/o/c/r.wav"), Error, /unreachable/u);
	});

	it("deletes both halves, and survives a mirror that refuses", async () => {
		await store.put("a/b.wav", Buffer.from("x"));
		await store.delete("a/b.wav");
		expect(await origin.exists("a/b.wav")).to.equal(false);
		expect(fake.body("a/b.wav")).to.equal(undefined);

		await store.put("a/c.wav", Buffer.from("x"));
		fake.failWith = new Error("bucket unreachable");
		await store.delete("a/c.wav");
		expect(await origin.exists("a/c.wav")).to.equal(false);
	});

	it("reports the filesystem path of the ORIGIN, which is what the engine hands Asterisk", () => {
		expect(store.filesystemPath("a/b.wav")).to.equal(join(root, "a/b.wav"));
	});
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * An in-process S3, answering the four commands `S3ObjectStore` sends.
 *
 * Dispatch is on the command's constructor NAME rather than on `instanceof`: the store imports the
 * SDK dynamically and this file must not force that import merely to name a class in a test. The
 * name is stable API — it is what appears in the SDK's own error messages and traces.
 */
class FakeS3 {
	readonly objects = new Map<string, Buffer>();
	readonly commands: { readonly name: string; readonly input: Record<string, unknown> }[] = [];
	/** Set to make the next send fail with a transport-shaped error rather than a 404. */
	failWith: Error | undefined;
	/** Which flavour of "no such object" to answer with; both are real. */
	notFoundStyle: "named" | "status-only" = "named";

	asClient(): S3Client {
		return this as unknown as S3Client;
	}

	put(key: string, bytes: Buffer): void {
		this.objects.set(key, bytes);
	}

	body(key: string): string | undefined {
		return this.objects.get(key)?.toString("utf8");
	}

	/** The input of the most recent command of a kind, so a spec can assert on the REQUEST. */
	lastOf(name: string): Record<string, unknown> {
		const found = [...this.commands].reverse().find((entry) => entry.name === name);
		if (found === undefined) {
			expect.fail(`no ${name} was sent`);
		}
		return found.input;
	}

	async send(command: {
		readonly constructor: { readonly name: string };
		readonly input: Record<string, unknown>;
	}): Promise<unknown> {
		const name = command.constructor.name;
		this.commands.push({ name, input: command.input });
		if (this.failWith !== undefined) {
			throw this.failWith;
		}
		const key = String(command.input.Key);
		const object = this.objects.get(key);

		if (name === "PutObjectCommand") {
			this.objects.set(key, Buffer.from(command.input.Body as Buffer));
			return {};
		}
		if (name === "DeleteObjectCommand") {
			this.objects.delete(key);
			return {};
		}
		if (object === undefined) {
			throw this.notFound();
		}
		if (name === "HeadObjectCommand") {
			return { ContentLength: object.length, ContentType: "audio/wav", LastModified: new Date() };
		}
		if (name === "GetObjectCommand") {
			const range = command.input.Range;
			if (typeof range !== "string") {
				return { Body: Readable.from([object]) };
			}
			const [start, end] = range.replace("bytes=", "").split("-").map(Number);
			// `end` is inclusive on the wire and exclusive in `subarray`, which is exactly the
			// off-by-one this fake exists to catch in the store rather than to reproduce.
			return { Body: Readable.from([object.subarray(start, (end as number) + 1)]) };
		}
		throw new Error(`the fake S3 does not implement ${name}`);
	}

	private notFound(): Error {
		const error = new Error("not found");
		if (this.notFoundStyle === "named") {
			error.name = "NoSuchKey";
		} else {
			error.name = "SomeGatewayError";
		}
		return Object.assign(error, { $metadata: { httpStatusCode: 404 } });
	}
}

function s3With(fake: FakeS3): S3ObjectStore {
	return new S3ObjectStore(S3_ENV, async () => fake.asClient());
}

async function drain(stream: Readable): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * `expect(promise).to.be.rejectedWith` without `chai-as-promised`'s plugin registration.
 *
 * `apps/api`'s mocha run has no shared setup file, so a plugin would have to be registered by every
 * spec that wanted it. Six lines here, and the failure message names the type that was expected.
 */
async function expectRejection(
	promise: Promise<unknown>,
	type: new (...args: never[]) => Error,
	message?: RegExp,
): Promise<void> {
	try {
		await promise;
	} catch (error) {
		expect(error, `expected a ${type.name}`).to.be.instanceOf(type);
		if (message !== undefined) {
			expect((error as Error).message).to.match(message);
		}
		return;
	}
	expect.fail(`expected a ${type.name}, but the promise resolved`);
}
