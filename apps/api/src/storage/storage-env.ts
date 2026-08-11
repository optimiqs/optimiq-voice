import { z } from "zod/v4";

/**
 * The object store's environment contract.
 *
 * Shaped after `mail-env.ts`, which is the closest precedent in this app: one optional capability
 * whose unconfigured state is legitimate, whose half-configured state is a boot failure, and whose
 * silently-degraded state is refused in production. The parallel is exact — a production deployment
 * writing password-reset links to a log is the same class of mistake as one storing a customer's
 * call audio on a container filesystem that will be replaced on the next deploy.
 *
 * `zod/v4` rather than `zod` for the reason `pbx-env.ts` records: this app still pins `zod@3.25.76`
 * and 3.25 ships the whole Zod 4 implementation under the `zod/v4` subpath.
 *
 * ## Unprefixed names
 *
 * `STORAGE_DRIVER` and the `S3_*` family carry no `API_` prefix, on the same terms as `SMTP_*` and
 * `NATS_URL`: an object store is a platform capability, and the next process that needs one —
 * `apps/mediad`, a retention job, a bulk export — must not have to read API-prefixed variables to
 * find the bucket the API is already writing to. `S3_*` is also what every S3-compatible tool
 * already reads in its own docs (MinIO, R2, Ceph), so an operator copying credentials from a
 * provider's console is copying them into the names the provider used.
 *
 * There is deliberately no `AWS_*` fallback. The AWS SDK reads `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` from the environment on its own when this schema leaves
 * the credentials unset (see `s3-object-store.ts`), so a deployment on an IAM role or an EC2/EKS
 * instance profile configures NOTHING here beyond the bucket and it works. Reading them into this
 * schema as well would produce two sources for one credential and a subtle difference in which one
 * wins.
 */

/** An orchestrator that wants a variable off sets it to `""`; "absent" is not expressible in YAML. */
const optionalString = z.string().trim().min(1).optional().catch(undefined);

/**
 * The driver, and why `local` is the default rather than "whatever is configured".
 *
 * A deployment that has never heard of this module keeps the behaviour it had — the filesystem
 * roots, the same paths, the same bytes — and the shipped `compose.yaml` keeps working with no new
 * variables. Selecting the object store is an ACT, not a consequence of having set `S3_BUCKET` in a
 * `.env` while experimenting.
 */
export const STORAGE_DRIVERS = ["local", "s3"] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

export const storageEnvSchema = z
	.object({
		/** `local` (the default) keeps the filesystem; `s3` adds an S3-compatible durable mirror. */
		STORAGE_DRIVER: z
			.enum(STORAGE_DRIVERS)
			.optional()
			.catch(undefined)
			.transform((value) => value ?? "local"),

		/** The bucket. Required when the driver is `s3`; there is no default and never will be one. */
		S3_BUCKET: optionalString,

		/**
		 * The region.
		 *
		 * Required by the SDK's signer even against a store that has no regions: MinIO and Ceph
		 * accept and ignore `us-east-1`, and R2 requires exactly `auto`. Left unset here the SDK
		 * falls back to `AWS_REGION` / the shared config file, which is what an IAM-role deployment
		 * wants, so this is optional in the schema and required by the PRODUCTION preflight.
		 */
		S3_REGION: optionalString,

		/**
		 * The endpoint, for anything that is not AWS S3 itself.
		 *
		 * `http://minio:9000` in development, `https://<account>.r2.cloudflarestorage.com` for R2,
		 * whatever the cluster publishes for Ceph. Absent means AWS's own endpoint for the region,
		 * which is the only case where the SDK can derive it.
		 */
		S3_ENDPOINT: optionalString,

		/**
		 * Static credentials.
		 *
		 * Optional as a PAIR: absent, the SDK's default provider chain runs (environment,
		 * `~/.aws/credentials`, the container/instance metadata service, web identity), which is how
		 * a deployment on an IAM role is supposed to be configured and is strictly better than a
		 * long-lived key in an environment variable. Set, they win. Half-set is refused below,
		 * because an access key id with no secret is not a configuration, it is the half of one that
		 * fails at the first request with an error nobody can trace back to here.
		 */
		S3_ACCESS_KEY_ID: optionalString,
		S3_SECRET_ACCESS_KEY: optionalString,

		/**
		 * Path-style addressing — `http://host/bucket/key` rather than `http://bucket.host/key`.
		 *
		 * Required by MinIO and by every store reached over an IP address or a bare hostname, because
		 * virtual-host addressing needs wildcard DNS the deployment does not have. Defaults to TRUE
		 * whenever `S3_ENDPOINT` is set and false otherwise (see {@link loadStorageEnv}): a custom
		 * endpoint is overwhelmingly a self-hosted store, and getting this wrong produces a DNS
		 * failure whose message says nothing about addressing style.
		 */
		S3_FORCE_PATH_STYLE: z
			.stringbool({ truthy: ["true", "1"], falsy: ["false", "0"] })
			.optional()
			.catch(undefined),

		/**
		 * An optional key prefix inside the bucket.
		 *
		 * For a deployment sharing one bucket across environments (`staging/`, `prod/`) rather than
		 * running two. Empty by default: the keys in the bucket are then byte-identical to the paths
		 * under the filesystem root, which is what makes an object recognisable in both places and
		 * makes a back-fill an `aws s3 sync` rather than a script.
		 */
		S3_PREFIX: optionalString,

		/** Per-request timeout for the store, in milliseconds. */
		S3_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
	})
	.superRefine((value, context) => {
		if (value.STORAGE_DRIVER === "s3" && value.S3_BUCKET === undefined) {
			context.addIssue({
				code: "custom",
				path: ["S3_BUCKET"],
				message: "must be set when STORAGE_DRIVER=s3",
			});
		}
		const hasId = value.S3_ACCESS_KEY_ID !== undefined;
		const hasSecret = value.S3_SECRET_ACCESS_KEY !== undefined;
		if (hasId !== hasSecret) {
			context.addIssue({
				code: "custom",
				path: [hasId ? "S3_SECRET_ACCESS_KEY" : "S3_ACCESS_KEY_ID"],
				message:
					"S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are set together or not at all; " +
					"leave both unset to use the AWS SDK's default credential chain",
			});
		}
	});

export type StorageEnvInput = z.infer<typeof storageEnvSchema>;

/** The parsed, resolved storage configuration. */
export interface StorageEnv {
	readonly driver: StorageDriver;
	readonly bucket: string | undefined;
	readonly region: string | undefined;
	readonly endpoint: string | undefined;
	readonly accessKeyId: string | undefined;
	readonly secretAccessKey: string | undefined;
	readonly forcePathStyle: boolean;
	readonly prefix: string;
	readonly timeoutMs: number;
}

/** Raised at boot when a production process would run a half-configured object store. */
export class StorageConfigurationFailure extends Error {
	readonly _tag = "StorageConfigurationFailure" as const;
	readonly missing: readonly string[];

	constructor(missing: readonly string[]) {
		super(
			`The object store cannot start in production: ${missing.join(", ")} must be set. ` +
				"STORAGE_DRIVER=s3 was selected, so every recording and every media upload is expected " +
				"to reach a bucket; without these the process would fall back to the container " +
				"filesystem and lose them on the next deploy. Set them in the root .env, or set " +
				"STORAGE_DRIVER=local to say the filesystem is what you meant.",
		);
		this.name = "StorageConfigurationFailure";
		this.missing = missing;
	}
}

/**
 * Parses the environment, throwing on a contract violation.
 *
 * Called from `main.ts` before `NestFactory.create` and from each area's module factory. A
 * `STORAGE_DRIVER=s3` with no bucket must stop the process at boot rather than surface as a failed
 * archive on somebody's first recorded call.
 */
export function loadStorageEnv(source: NodeJS.ProcessEnv = process.env): StorageEnv {
	const parsed = storageEnvSchema.safeParse(source);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid storage environment — ${detail}`);
	}
	const value = parsed.data;
	return {
		driver: value.STORAGE_DRIVER,
		bucket: value.S3_BUCKET,
		region: value.S3_REGION,
		endpoint: value.S3_ENDPOINT?.replace(/\/+$/u, ""),
		accessKeyId: value.S3_ACCESS_KEY_ID,
		secretAccessKey: value.S3_SECRET_ACCESS_KEY,
		// A custom endpoint is overwhelmingly a self-hosted store; see the field's own note.
		forcePathStyle: value.S3_FORCE_PATH_STYLE ?? value.S3_ENDPOINT !== undefined,
		// Normalised to "" or "<something>/" so key building is a concatenation with no branch.
		prefix: normalizePrefix(value.S3_PREFIX),
		timeoutMs: value.S3_TIMEOUT_MS,
	};
}

/** True when this environment can actually reach a bucket. */
export function isS3Configured(env: StorageEnv): boolean {
	return env.driver === "s3" && env.bucket !== undefined && env.region !== undefined;
}

/**
 * The boot preflight: a production process may not select `s3` and get the filesystem.
 *
 * Called from `main.ts` alongside the mail and CDR preflights, before `NestFactory.create`, because
 * booting is the last moment a misconfiguration can be turned into a refusal to start rather than
 * into a month of recordings that only ever existed on one container's disk.
 *
 * `driver=local` passes unconditionally and in every environment. It is not a degraded mode, it is
 * the shipped topology: `compose.yaml` has no object-store service, one box with a volume is a
 * legitimate deployment, and refusing to boot it would be this preflight inventing a requirement.
 */
export function assertStoragePreflight(
	env: StorageEnv,
	nodeEnv: string | undefined = process.env.NODE_ENV,
): void {
	if (env.driver !== "s3" || nodeEnv !== "production" || isS3Configured(env)) {
		return;
	}
	const missing: string[] = [];
	if (env.bucket === undefined) missing.push("S3_BUCKET");
	if (env.region === undefined) missing.push("S3_REGION");
	throw new StorageConfigurationFailure(missing);
}

/** `"media"` and `"media/"` and `"/media/"` all mean the same thing; `undefined` means none. */
function normalizePrefix(raw: string | undefined): string {
	if (raw === undefined) {
		return "";
	}
	const trimmed = raw.replace(/^\/+|\/+$/gu, "");
	return trimmed === "" ? "" : `${trimmed}/`;
}
