import { z } from "zod/v4";

/**
 * The CDR area's environment contract.
 *
 * `zod/v4` rather than `zod` for the reason `pbx-env.ts` records: `apps/api` still pins
 * `zod@3.25.76` for ~19 legacy files, and 3.25 ships the whole Zod 4 implementation under the
 * `zod/v4` subpath.
 *
 * App-local rather than a slice of `@optimiq-voice/config`, same as the PBX area. This is the one
 * place in the CDR area that may read `process.env`; everything else injects the parsed
 * {@link CdrEnv}.
 */

const postgresUrl = z
	.string()
	.min(1)
	.regex(/^postgres(?:ql)?:\/\//iu, "must be a postgres:// URL");

/**
 * A broker URL, where the EMPTY STRING means "explicitly none".
 *
 * `.optional()` alone distinguishes absent from present, and an orchestrator cannot express
 * "absent": `docker compose`, Kubernetes and a spawned process with an env override all set a
 * variable to `""` when they want to turn it off, and inherit the parent's value if they omit it.
 * Without this preprocess, "run this API with no broker" is unexpressible in exactly the
 * environments where it is most needed, and the failure is a boot crash rather than the intended
 * degraded mode. `apps/web`'s CDR smoke is the first caller that needed it.
 */
const natsUrl = z.preprocess(
	(value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
	z
		.string()
		.min(1)
		.regex(/^nats:\/\//iu, "must be a nats:// URL, e.g. nats://localhost:4222")
		.optional(),
);

/**
 * One half of the broker credential, on the same "empty string means explicitly none" terms as
 * {@link natsUrl} above. Optional because the verify harnesses and `test/` run against a throwaway
 * `nats` container with no authentication configured; `assertEnvInvariants` is what makes both
 * mandatory in production.
 */
const natsCredential = z.preprocess(
	(value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
	z.string().min(1).optional(),
);

/**
 * The signing key for recording download URLs.
 *
 * 32 characters is not decoration: the token is the ONLY thing standing between an anonymous
 * fetcher and a customer's call audio, so a key short enough to brute-force is a key that does not
 * work. It is validated at boot rather than at first download, because the failure mode of a weak
 * key is silent.
 */
const signingSecret = z.string().min(32, "must be at least 32 characters");

export const cdrEnvSchema = z.object({
	/**
	 * The reporting bounded context's database. Its own database and its own connection budget —
	 * never shared with `DATABASE_URL` or `PBX_DATABASE_URL`, and there are no cross-database joins.
	 */
	CDR_DATABASE_URL: postgresUrl,

	/**
	 * Optional by design, exactly as in the PBX area: without a broker the durable writers are
	 * skipped with a boot warning and the reporting API still serves every row already in the
	 * database. A reporting surface that refused to start because the message bus was down would
	 * take the call history offline for a reason that has nothing to do with call history.
	 */
	NATS_URL: natsUrl,

	/**
	 * How the durable writers authenticate to that broker.
	 *
	 * `NATS_API_USER` / `NATS_API_PASS` are this process's own least-privilege identity, with
	 * `NATS_USER` / `NATS_PASS` as the operator fallback — see `pbx-env.ts` for the full note and
	 * `config/nats.conf` for the permission set. The two writers here need `cdr.leg.v1.*` and
	 * `calls.evt.v1.*.*.channel.record.*` deliveries, both of which the `api` user is granted.
	 */
	NATS_USER: natsCredential,
	NATS_PASS: natsCredential,
	NATS_API_USER: natsCredential,
	NATS_API_PASS: natsCredential,

	/** Broker transport security; off unless set. See `pbx-env.ts`. */
	NATS_TLS_CA: z.string().min(1).optional(),
	NATS_TLS_ENABLED: z.string().optional(),

	CDR_DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(2).max(100).default(10),

	/**
	 * Whether the durable writers run in THIS process.
	 *
	 * Default true, but it is a switch rather than an assumption: the writer is a singleton
	 * workload (one durable consumer, shared across replicas by JetStream) and an operator running
	 * the API behind a load balancer may want the writer isolated in one deployment so its backlog
	 * and its restarts are not tangled up with request latency. Turning it off does not change the
	 * reporting API at all.
	 */
	CDR_WRITER_ENABLED: z
		.stringbool({ truthy: ["true", "1"], falsy: ["false", "0", ""] })
		.default(true),

	/**
	 * How many months of partitions the writer keeps ahead of itself.
	 *
	 * 2 (current + next) is the minimum that keeps a leg starting at 23:59 on the last day of a
	 * month off the default partition. The writer also ensures a month on demand before an insert
	 * that falls outside what it has already ensured, so this is a warm-up, not a guarantee.
	 */
	CDR_PARTITION_HORIZON_MONTHS: z.coerce.number().int().min(1).max(24).default(2),

	/**
	 * HMAC key for recording download URLs.
	 *
	 * Optional: an environment that has not configured it still serves the recordings LIST — the
	 * metadata is not the media — and refuses to mint a download URL with a named error rather than
	 * falling back to an unsigned route. There is no default and there never will be one; a
	 * hard-coded signing key is the same as no signing key.
	 */
	CDR_RECORDING_URL_SECRET: signingSecret.optional(),

	/**
	 * The PREVIOUS signing key, accepted for verification only.
	 *
	 * This is how the key is rotated without invalidating every URL already handed out: set the new
	 * key as `CDR_RECORDING_URL_SECRET` and move the old one here, deploy, and after the TTL has
	 * elapsed (minutes, not days — see below) remove it. Tokens are only ever MINTED with the
	 * current key, so a compromised old key stops being useful as soon as it is dropped.
	 */
	CDR_RECORDING_URL_SECRET_PREVIOUS: signingSecret.optional(),

	/**
	 * How long a minted download URL stays valid.
	 *
	 * Five minutes by default and capped at an hour. The URL is a bearer credential that ends up in
	 * browser history, in an `<audio src>` and in any proxy log between here and the user, so its
	 * value has to decay faster than those places are read. Long-lived media links are the reason
	 * the anonymous route this replaces was a problem in the first place.
	 */
	CDR_RECORDING_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

	/**
	 * Where recording objects live.
	 *
	 * A filesystem root today, matching what `apps/engine` writes. Only the signed media route
	 * reaches into it. When the S3-compatible store lands, this becomes a bucket
	 * and `GET …/media/:token` answers with a 302 to a presigned object URL — the token scheme
	 * above does not change, because it authorizes the REQUEST, not the storage.
	 */
	CDR_RECORDING_ROOT: z.string().min(1).default("/opt/optimiq-voice/recordings"),

	/**
	 * How long a call recording is kept before it is purged, in days — the PLATFORM's answer,
	 * used when an organization has not given its own.
	 *
	 * Stamped onto `recordings.retention_until` when the row is written, because that is the only
	 * moment the policy in force is unambiguous: applying today's window retroactively to a row
	 * recorded under last year's is exactly the mistake a retention policy exists to prevent, and a
	 * customer who shortened their window should not have three-year-old audio disappear as a side
	 * effect of a settings change.
	 *
	 * `0` — the default, and what every release before this one did implicitly — means keep
	 * indefinitely: `retention_until` stays null and the sweeper never sees the row. That remains
	 * the default because deleting a tenant's audio is not a thing to start doing on an upgrade.
	 *
	 * ## Where the per-organization window comes from
	 *
	 * The tenant's own window is the `recordings.retentionDays` org setting (`org-settings.catalog.ts`,
	 * guarded by `recordings.configure`), and it reaches this area WITHOUT the cross-database import
	 * an earlier version of this comment refused: the CDR area owns a port
	 * (`recordings/retention-policy.ts`), the PBX side implements it over a per-organization TTL
	 * cache, and `recording-writer.service.ts` injects it `@Optional()`. The org value — including
	 * an explicit `0` — wins whenever it exists; this variable decides for the three absences (no
	 * PBX area mounted, no window ever set, the policy read failing). The refusal's grounds were
	 * real and are still honoured — no `PbxDatabaseClient` in this module, and the cache keeps the
	 * write path at one foreign query per organization per minute rather than one per recording.
	 */
	CDR_RECORDING_RETENTION_DAYS: z.coerce.number().int().min(0).max(3_650).default(0),

	/**
	 * How often the recording purge runs in this process. `0` disables it.
	 *
	 * The sweep deletes the OBJECT first and tombstones the row only for the objects that actually
	 * went, so an interval that is missed costs latency and never correctness. Hourly by default:
	 * a retention window is measured in days, so anything finer only adds load.
	 *
	 * It runs under the same `CDR_WRITER_ENABLED` switch as the durable consumers, for the same
	 * reason — it is a singleton workload, and N API replicas each purging the same batch would be
	 * N-1 wasted passes over an object store.
	 */
	CDR_RECORDING_SWEEP_INTERVAL_MS: z.coerce
		.number()
		.int()
		.min(0)
		.max(86_400_000)
		.default(3_600_000),

	/** Recordings purged in one pass. Bounded so one sweep cannot hold the pool for minutes. */
	CDR_RECORDING_SWEEP_BATCH: z.coerce.number().int().min(1).max(1_000).default(200),

	/**
	 * Where CDR export objects live.
	 *
	 * A root of its own rather than a sub-prefix of `CDR_RECORDING_ROOT`, and the reason is a
	 * property no other object class in this API has: **Asterisk never touches an export.** Every
	 * other root here is on a volume the media server shares — which is exactly why
	 * `object-store.factory.ts` has no branch that returns a bare `S3ObjectStore`, and why the S3
	 * driver mirrors rather than replaces the filesystem. An export is written by this process and
	 * read by this process, so it is the one class that could legitimately live only in a bucket.
	 *
	 * It still goes through `createObjectStore`, so today it mirrors like the rest. Separating the
	 * root now is what makes moving it later a configuration change rather than a code change, and
	 * it means an operator can put reports on a different volume from audio — different sizes,
	 * different retention, different backup policy.
	 */
	CDR_EXPORT_ROOT: z.string().min(1).default("/opt/optimiq-voice/exports"),

	/**
	 * How often the export worker looks for a queued job. `0` disables it.
	 *
	 * Fifteen seconds, which is a latency budget rather than a load one: the poll is an index scan
	 * over a partial index that is empty almost all of the time, and the number is chosen so a
	 * person who clicks "Export" sees the job start moving before they wonder whether it worked.
	 *
	 * It runs under `CDR_WRITER_ENABLED` with the durable consumers and the recording sweep. Unlike
	 * those, N replicas polling would still be CORRECT — the claim is a `skip locked` compare-and-set
	 * — so this switch is about cost, and an operator who wants export throughput enables the writer
	 * in more than one place on purpose.
	 */
	CDR_EXPORT_POLL_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(15_000),

	/**
	 * How long a claimed export may go quiet before another worker may take it.
	 *
	 * The claim commits immediately rather than holding a transaction across the export, so a worker
	 * that dies mid-write leaves a row stuck in `running` that nothing would otherwise touch. This
	 * is what unsticks it. Ten minutes: comfortably longer than the largest export a bounded row
	 * count can produce, and short enough that a crash is not an outage.
	 */
	CDR_EXPORT_LEASE_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(600_000),

	/**
	 * The most rows one export may contain before it is failed.
	 *
	 * FAILED, never truncated — a truncated CSV is a plausible-looking file with no marker saying
	 * where it stopped, and somebody will total a column in it. The ceiling is really about memory:
	 * `ObjectStore.put` takes a `Buffer`, so the whole file is assembled before it is stored, and a
	 * hundred thousand legs is roughly 25 MB. Raising this far beyond that means growing a streaming
	 * `upload` path on `MirroredObjectStore.put`, which names itself as the method that would.
	 */
	CDR_EXPORT_MAX_ROWS: z.coerce.number().int().min(1_000).max(2_000_000).default(100_000),

	/**
	 * How long a finished export stays downloadable, in hours.
	 *
	 * Expiring by DEFAULT, which is the opposite of `recordings.retention_until` (null, keep for
	 * ever, until a policy says otherwise). The asymmetry is deliberate: a recording is the primary
	 * record of a conversation and deleting it destroys something; an export is a derived copy of
	 * the ledger sitting outside the ledger's own access controls, and a report nobody fetched in a
	 * week is a liability rather than an asset. Seven days is long enough for a monthly reporting
	 * cycle to be re-run rather than re-requested.
	 *
	 * Only the FILE expires. The job row — who asked, for what window, with what filters — survives,
	 * because that is the record an audit of "who extracted the call history" reads.
	 */
	CDR_EXPORT_TTL_HOURS: z.coerce.number().int().min(1).max(8_760).default(168),
});

export type CdrEnv = z.infer<typeof cdrEnvSchema>;

/** Whether the area is configured at all. `main.ts` skips the module entirely when it is not. */
export function isCdrSliceConfigured(source: NodeJS.ProcessEnv = process.env): boolean {
	return typeof source.CDR_DATABASE_URL === "string" && source.CDR_DATABASE_URL.length > 0;
}

/**
 * Parses the environment, throwing on a contract violation.
 *
 * Called from the module factory, which Nest builds during `NestFactory.create` — before any
 * request can arrive. A 20-character signing secret must stop the process at boot, not surface as
 * a download URL somebody can forge.
 */
export function loadCdrEnv(source: NodeJS.ProcessEnv = process.env): CdrEnv {
	const parsed = cdrEnvSchema.safeParse(source);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid CDR environment — ${detail}`);
	}
	return parsed.data;
}
