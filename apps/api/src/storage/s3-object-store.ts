import { ObjectNotFoundError } from "./object-store";
import type { ObjectRange, ObjectStat, ObjectStore, PutObjectOptions } from "./object-store";
import type { StorageEnv } from "./storage-env";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

/**
 * The S3-compatible driver: AWS S3, MinIO, Cloudflare R2, Ceph RGW, anything that speaks the API.
 *
 * ## The SDK is imported lazily, and that is not a micro-optimisation
 *
 * `@aws-sdk/client-s3` is a large module graph — the client, the signer, the credential provider
 * chain, the checksum middleware — and `STORAGE_DRIVER=local` is the default and will remain the
 * default for every single-box deployment. Loading all of it at import time would put it in the
 * boot path of every process that will never call it, including `apps/api`'s test run and every
 * `verify:*` harness. So the client is built on first use behind `await import(...)`, the same
 * pattern `recording-writer.service.ts` uses for `@optimiq-voice/events`, and a `local` deployment
 * never pays for a dependency it does not exercise.
 *
 * The consequence to know about: a broken credential or an unreachable endpoint surfaces on the
 * FIRST operation rather than at construction. That is why `assertStoragePreflight` exists in
 * `storage-env.ts` — the configuration is checked at boot even though the connection is not.
 *
 * ## Endpoint, path style, region — the three things that make this work off AWS
 *
 * - `endpoint` set means "not AWS": `http://minio:9000`, an R2 account URL, a Ceph gateway.
 * - `forcePathStyle` follows it by default (`storage-env.ts` explains why) because virtual-host
 *   addressing needs wildcard DNS that a self-hosted store does not have.
 * - `region` is required by the SIGNER even where the store has no regions. MinIO and Ceph accept
 *   and ignore `us-east-1`; R2 requires exactly `auto`.
 *
 * Credentials are passed only when both halves are configured. Left out, the SDK's default provider
 * chain runs — environment, shared config file, container/instance metadata, web identity — which is
 * how an IAM-role deployment is meant to be configured and is strictly better than a long-lived key
 * in an environment variable. `storage-env.ts` refuses a half-set pair so this branch is a real
 * either/or rather than a silent partial.
 *
 * ## Keys
 *
 * The bucket key is `<prefix><objectKey>` with the prefix normalised to `""` or `"<something>/"`.
 * With no prefix — the default — the keys in the bucket are byte-identical to the paths under the
 * filesystem root, which is what makes an object recognisable in both places and makes a back-fill
 * an `aws s3 sync` rather than a script. There is no sanitisation and none is needed: every key is
 * built from UUIDs this server minted (`media-storage.ts` says why) and S3 has no `..`.
 */
export class S3ObjectStore implements ObjectStore {
	readonly driver = "s3" as const;
	readonly bucket: string;

	private readonly env: StorageEnv;
	private readonly createClient: (() => Promise<S3Client>) | undefined;
	private client: Promise<S3Client> | undefined;

	/**
	 * @param createClient A seam for the tests, and only for the tests.
	 *
	 * `connect()` builds the client behind a dynamic `import`, which is exactly the shape a unit test
	 * cannot reach into: there is no module registry to patch under `tsx`, and a test that reached
	 * one would be asserting against `@aws-sdk`'s internals rather than against this class. An
	 * optional factory keeps the production path a single expression with no branch on an
	 * environment flag, and lets `test/storage` drive every method against an in-process fake with no
	 * socket. Production callers pass one argument; the factory never does.
	 */
	constructor(env: StorageEnv, createClient?: () => Promise<S3Client>) {
		this.createClient = createClient;
		if (env.bucket === undefined) {
			// Unreachable through the factory, which only builds this store for a parsed env whose
			// schema requires a bucket under `STORAGE_DRIVER=s3`. Stated anyway: a store with no
			// bucket would produce requests to a URL with an empty path segment, which some
			// implementations answer with a 200 and a bucket LISTING.
			throw new Error("an S3 object store needs S3_BUCKET");
		}
		this.env = env;
		this.bucket = env.bucket;
	}

	/** The bucket key for an object key. Exposed for the tests and for a log line worth reading. */
	bucketKey(objectKey: string): string {
		return `${this.env.prefix}${objectKey}`;
	}

	/** No filesystem behind this store — the answer Asterisk-facing callers must check. */
	filesystemPath(_objectKey: string): string | undefined {
		return undefined;
	}

	async head(objectKey: string): Promise<ObjectStat | undefined> {
		const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
		const client = await this.connect();
		try {
			const response = await client.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: this.bucketKey(objectKey) }),
			);
			return {
				sizeBytes: response.ContentLength ?? 0,
				contentType: response.ContentType,
				updatedAt: response.LastModified,
			};
		} catch (error) {
			if (isNotFound(error)) {
				return undefined;
			}
			throw error;
		}
	}

	async exists(objectKey: string): Promise<boolean> {
		return (await this.head(objectKey)) !== undefined;
	}

	/**
	 * Opens the object, optionally one byte range.
	 *
	 * The range goes on the REQUEST as an HTTP `Range` header, so the store sends the bytes that were
	 * asked for and this process never sees the rest. A driver that fetched the object and sliced it
	 * would turn a scrub-bar drag on an hour-long recording into an hour-long download, per drag, per
	 * listener.
	 */
	async getStream(objectKey: string, range?: ObjectRange): Promise<Readable> {
		const { GetObjectCommand } = await import("@aws-sdk/client-s3");
		const client = await this.connect();
		try {
			const response = await client.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: this.bucketKey(objectKey),
					...(range === undefined ? {} : { Range: `bytes=${range.start}-${range.end}` }),
				}),
			);
			const body = response.Body;
			if (body === undefined) {
				throw new ObjectNotFoundError(objectKey);
			}
			// On Node the SDK's `Body` is always a `Readable`; the union in its type exists for the
			// browser build (`ReadableStream`) and for React Native (`Blob`), neither of which this
			// process can be. Narrowed by assertion rather than by a runtime branch that could never
			// be taken and could never be tested.
			return body as Readable;
		} catch (error) {
			if (isNotFound(error)) {
				throw new ObjectNotFoundError(objectKey);
			}
			throw error;
		}
	}

	async put(objectKey: string, bytes: Buffer, options?: PutObjectOptions): Promise<void> {
		const { PutObjectCommand } = await import("@aws-sdk/client-s3");
		const client = await this.connect();
		await client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: this.bucketKey(objectKey),
				Body: bytes,
				// `ContentLength` explicitly: without it the SDK streams with a chunked encoding that
				// some S3-compatible stores (older MinIO, several gateways) reject outright.
				ContentLength: bytes.length,
				...(options?.contentType === undefined ? {} : { ContentType: options.contentType }),
				...(options?.metadata === undefined ? {} : { Metadata: { ...options.metadata } }),
			}),
		);
	}

	/** Deletes an object. S3's `DeleteObject` is already idempotent, so absence is a success. */
	async delete(objectKey: string): Promise<void> {
		const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
		const client = await this.connect();
		await client.send(
			new DeleteObjectCommand({ Bucket: this.bucket, Key: this.bucketKey(objectKey) }),
		);
	}

	/**
	 * A presigned `GET`, valid for `ttlSeconds`.
	 *
	 * Available, and NOT used on the request path — see the signed-URL decision recorded in
	 * `object-store.factory.ts`. It exists for the cases where redirecting is obviously right (a
	 * bulk export, an out-of-band integration handed a URL it will fetch once) and so that the seam
	 * does not have to be widened by whoever needs one under time pressure.
	 */
	async presign(objectKey: string, ttlSeconds: number): Promise<string | undefined> {
		const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([
			import("@aws-sdk/client-s3"),
			import("@aws-sdk/s3-request-presigner"),
		]);
		const client = await this.connect();
		return await getSignedUrl(
			client,
			new GetObjectCommand({ Bucket: this.bucket, Key: this.bucketKey(objectKey) }),
			{ expiresIn: ttlSeconds },
		);
	}

	/** The client, built once. The promise itself is memoised so two concurrent calls build one. */
	private async connect(): Promise<S3Client> {
		this.client ??= (
			this.createClient ??
			(async (): Promise<S3Client> => {
				const { S3Client: Client } = await import("@aws-sdk/client-s3");
				return new Client({
					...(this.env.region === undefined ? {} : { region: this.env.region }),
					...(this.env.endpoint === undefined ? {} : { endpoint: this.env.endpoint }),
					forcePathStyle: this.env.forcePathStyle,
					requestHandler: {
						requestTimeout: this.env.timeoutMs,
						connectionTimeout: Math.min(this.env.timeoutMs, 10_000),
					},
					...(this.env.accessKeyId === undefined || this.env.secretAccessKey === undefined
						? {}
						: {
								credentials: {
									accessKeyId: this.env.accessKeyId,
									secretAccessKey: this.env.secretAccessKey,
								},
							}),
				});
			})
		)();
		return await this.client;
	}
}

/**
 * Whether an SDK error means "there is no such object".
 *
 * Three spellings, all of them real: `HeadObject` answers a bare `NotFound` with no body (there is
 * nowhere to put an error code in a HEAD response), `GetObject` answers `NoSuchKey`, and several
 * S3-compatible stores answer neither name but do set the status. Matching on the status as well is
 * what keeps this working against MinIO and Ceph rather than only against AWS.
 */
function isNotFound(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const name = (error as { readonly name?: unknown }).name;
	if (name === "NotFound" || name === "NoSuchKey") {
		return true;
	}
	const status = (error as { readonly $metadata?: { readonly httpStatusCode?: unknown } }).$metadata
		?.httpStatusCode;
	return status === 404;
}
