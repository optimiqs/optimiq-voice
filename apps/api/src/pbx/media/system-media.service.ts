import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { eq, mohClass, prompt } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE, PBX_ENV, PBX_MEDIA_STORE } from "../shared/pbx.tokens";
import { WAV_FORMAT } from "./media-audio";
import { mohLibraryObjectKey, mohLibraryPlan } from "./moh-library";
import { renderMusicOnHoldConf } from "./musiconhold-conf";
import {
	renderSystemAsset,
	SYSTEM_MEDIA_ASSETS,
	SYSTEM_MEDIA_MANIFEST_KEY,
	SYSTEM_MEDIA_VERSION,
	systemMediaChecksum,
	systemMediaObjectKey,
} from "./system-media";
import type { ObjectStore } from "../../storage";
import type { PbxEnv } from "../shared/pbx-env";
import type { MohLibrarySkip } from "./moh-library";
import type { MohClassRow } from "./musiconhold-conf";
import type { SystemMediaManifest } from "./system-media";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/** What one pass decided, per asset. Returned so a script and a test can assert on it. */
export interface SystemMediaSeedResult {
	readonly written: readonly string[];
	readonly unchanged: readonly string[];
	/** Keys left alone because the bytes there are not any version this seeder wrote. */
	readonly preserved: readonly string[];
	readonly failed: readonly { readonly objectKey: string; readonly error: string }[];
}

/**
 * Puts the platform's own audio into the object store, once, at boot.
 *
 * ## Why the API and not a migration
 *
 * The files belong to the OBJECT STORE, and the object store is not the database: a migration
 * runner has no `ObjectStore`, no `PBX_MEDIA_OBJECT_ROOT`, and no way to reach an S3 mirror. This
 * process has all three already wired (`pbx.module.ts` builds `PBX_MEDIA_STORE`), and it is the
 * process every deployment starts. `PBX_ENSURE_KV_BUCKETS` set the precedent for an idempotent
 * "make sure the thing this release needs exists" step on boot; this is the same shape against a
 * different store.
 *
 * It also means a deployment gets the audio with no operator step at all — which matters, because
 * the failure it prevents is invisible until a caller hits it. `apps/asterisk/README.md` already
 * records what happens when a media step is left to an operator: the class exists, the row is
 * right, and the caller hears nothing.
 *
 * ## Idempotence, and the one thing it must never do
 *
 * The manifest at {@link SYSTEM_MEDIA_MANIFEST_KEY} records the checksum of the bytes this seeder
 * last wrote at each key. On every boot each asset is compared against it:
 *
 * - key absent → write it.
 * - key present, bytes match a checksum this seeder wrote (the current one, or the one recorded in
 *   the manifest) → leave it, count it unchanged.
 * - key present, bytes are anything else → **leave it and say so.** Those are an operator's own
 *   recording, dropped at the stem `system-media.ts` documents. Overwriting them on every restart
 *   would make a real prompt pack impossible to install, which would make this seeder a downgrade
 *   rather than a floor.
 *
 * Deciding that costs a HEAD and a read per asset, and the whole catalogue is a few hundred
 * kilobytes of 8 kHz mono, so an already-seeded deployment boots having read less than one
 * voicemail message and written nothing.
 *
 * ## Failure is logged, never fatal
 *
 * A read-only mount or a full disk must not stop the API from starting: the rest of the control
 * plane works without hold music, and an API that refuses to boot takes the admin UI down with it —
 * the one place an operator would go to fix the mount. Every failure is logged with the key.
 */
@Injectable()
export class SystemMediaService implements OnModuleInit {
	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_MEDIA_STORE) private readonly store: ObjectStore,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.env.PBX_ENSURE_SYSTEM_MEDIA) {
			logger.info(
				{ root: this.env.PBX_MEDIA_OBJECT_ROOT },
				"PBX_ENSURE_SYSTEM_MEDIA is off; the system prompt set and the default music-on-hold " +
					"class are the deployment's own to provide",
			);
			return;
		}
		const result = await this.seed();
		logger.info(
			{
				root: this.env.PBX_MEDIA_OBJECT_ROOT,
				version: SYSTEM_MEDIA_VERSION,
				written: result.written.length,
				unchanged: result.unchanged.length,
				preserved: result.preserved.length,
				failed: result.failed.length,
			},
			`system media: ${result.written.length} written, ${result.unchanged.length} already ` +
				`current, ${result.preserved.length} left as the deployment's own`,
		);
		for (const failure of result.failed) {
			logger.error(
				{ objectKey: failure.objectKey, err: failure.error },
				"could not seed a system media asset; callers reaching it will hear silence",
			);
		}
		await this.publishMohLibrary();
	}

	/**
	 * Publishes every tenant hold-music class under the NAME the media plane addresses it by.
	 *
	 * See `moh-library.ts` for why this is a copy and not a protocol change. It runs at boot, which
	 * is the same cadence `musiconhold.conf` has ("the media server picks this up on restart") — an
	 * admin who uploads hold music mid-day gets it on the next API restart, and the skip reasons are
	 * in the log so "why is my class silent" has an answer that is not a packet capture.
	 */
	async publishMohLibrary(): Promise<{
		readonly published: readonly string[];
		readonly skipped: readonly MohLibrarySkip[];
	}> {
		const [classes, files] = await this.readMohLibrary();
		const filesByClass = new Map<string, { id: string; objectKey: string }[]>();
		const counts = new Map<string, number>();
		for (const file of files) {
			if (file.mohClassId === null || file.objectKey === null) {
				continue;
			}
			counts.set(file.mohClassId, (counts.get(file.mohClassId) ?? 0) + 1);
			const bucket = filesByClass.get(file.mohClassId);
			if (bucket === undefined) {
				filesByClass.set(file.mohClassId, [{ id: file.id, objectKey: file.objectKey }]);
			} else {
				bucket.push({ id: file.id, objectKey: file.objectKey });
			}
		}
		const rows: MohClassRow[] = classes.map((row) => ({
			id: row.id,
			organizationId: row.organizationId,
			name: row.name,
			source: row.source,
			streamUri: row.streamUri,
			shuffle: row.shuffle,
			sampleRateHz: row.sampleRateHz,
			enabled: row.enabled,
			fileCount: counts.get(row.id) ?? 0,
		}));

		// The renderer is asked only for its DECISION, not its file: `containerObjectRoot` never
		// reaches a caller here, and generating the Asterisk conf is `generate:musiconhold`'s job.
		const render = renderMusicOnHoldConf(rows, {
			containerObjectRoot: this.env.PBX_MEDIA_OBJECT_ROOT,
		});
		const plan = mohLibraryPlan(rows, render.declared, filesByClass);

		const published: string[] = [];
		for (const entry of plan.entries) {
			const objectKey = mohLibraryObjectKey(entry.name);
			try {
				const bytes = await this.read(entry.sourceObjectKey);
				const existing = await this.store.head(objectKey);
				if (
					existing?.sizeBytes === bytes.length &&
					systemMediaChecksum(await this.read(objectKey)) === systemMediaChecksum(bytes)
				) {
					continue;
				}
				await this.store.put(objectKey, bytes, { contentType: WAV_FORMAT.contentType });
				published.push(objectKey);
			} catch (error) {
				logger.error(
					{ objectKey, sourceObjectKey: entry.sourceObjectKey, err: describe(error) },
					"could not publish a music-on-hold class for the media plane; callers on it hear silence",
				);
			}
		}

		logger.info(
			{ published: published.length, skipped: plan.skipped.length },
			`music on hold: ${plan.entries.length} class(es) playable by name, ` +
				`${plan.skipped.length} not published`,
		);
		for (const skip of plan.skipped) {
			logger.warn(
				{ name: skip.name, organizationId: skip.organizationId, reason: skip.reason },
				`music-on-hold class "${skip.name}" is not playable by name (${skip.reason}); ` +
					"callers on it fall back to the default class",
			);
		}
		return { published, skipped: plan.skipped };
	}

	/**
	 * Every class and every MOH file on the platform, read as the OWNER principal.
	 *
	 * `withTenantScope` is deliberately not used, for the reason `generate-musiconhold.ts` records
	 * at length: the media server has ONE class namespace for the whole box, and the cross-tenant
	 * read is what makes the collision check possible at all.
	 */
	private async readMohLibrary() {
		return await Promise.all([
			this.database.adminDb.select().from(mohClass),
			this.database.adminDb
				.select({ id: prompt.id, mohClassId: prompt.mohClassId, objectKey: prompt.objectKey })
				.from(prompt)
				.where(eq(prompt.kind, "moh")),
		]);
	}

	/** One pass over the catalogue. Exported behaviour: a script and the tests call this directly. */
	async seed(): Promise<SystemMediaSeedResult> {
		const manifest = await this.readManifest();
		const written: string[] = [];
		const unchanged: string[] = [];
		const preserved: string[] = [];
		const failed: { objectKey: string; error: string }[] = [];
		const checksums: Record<string, string> = {};

		for (const asset of SYSTEM_MEDIA_ASSETS) {
			const objectKey = systemMediaObjectKey(asset);
			const bytes = renderSystemAsset(asset);
			const checksum = systemMediaChecksum(bytes);
			checksums[objectKey] = checksum;
			try {
				const state = await this.inspect(objectKey, checksum, manifest?.assets[objectKey]);
				if (state === "current") {
					unchanged.push(objectKey);
					continue;
				}
				if (state === "foreign") {
					preserved.push(objectKey);
					// The manifest keeps OUR checksum for the key regardless: if the operator later
					// removes their file, the next boot puts this release's asset back rather than
					// deciding the key is theirs forever.
					continue;
				}
				await this.store.put(objectKey, bytes, { contentType: WAV_FORMAT.contentType });
				written.push(objectKey);
			} catch (error) {
				failed.push({ objectKey, error: describe(error) });
			}
		}

		await this.writeManifest(checksums, failed);
		return { written, unchanged, preserved, failed };
	}

	/**
	 * Whether the key already holds this release's asset, an older one of ours, or somebody else's.
	 *
	 * The HEAD is what makes absence cheap — the fresh-install case, and the only one where the
	 * answer is reachable without reading anything. Everything else is decided on the bytes, because
	 * a size is not evidence of authorship and this is the check that stands between an operator's
	 * own recording and a restart that overwrites it.
	 */
	private async inspect(
		objectKey: string,
		checksum: string,
		recorded: string | undefined,
	): Promise<"absent" | "current" | "stale" | "foreign"> {
		const stat = await this.store.head(objectKey);
		if (stat === undefined) {
			return "absent";
		}
		const actual = systemMediaChecksum(await this.read(objectKey));
		if (actual === checksum) {
			return "current";
		}
		// Ours, but from an older catalogue: replace it. `recorded` is the only evidence that this
		// release did not simply find a file it has never seen.
		return recorded !== undefined && recorded === actual ? "stale" : "foreign";
	}

	private async read(objectKey: string): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of await this.store.getStream(objectKey)) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
		}
		return Buffer.concat(chunks);
	}

	private async readManifest(): Promise<SystemMediaManifest | undefined> {
		try {
			const parsed: unknown = JSON.parse((await this.read(SYSTEM_MEDIA_MANIFEST_KEY)).toString());
			if (typeof parsed !== "object" || parsed === null) {
				return undefined;
			}
			const assets = (parsed as { assets?: unknown }).assets;
			return typeof assets === "object" && assets !== null
				? (parsed as SystemMediaManifest)
				: undefined;
		} catch {
			// No manifest is the state of a fresh deployment and of one whose store was wiped. Both
			// want a full pass, which is what `undefined` produces.
			return undefined;
		}
	}

	private async writeManifest(
		assets: Readonly<Record<string, string>>,
		failed: readonly { readonly objectKey: string }[],
	): Promise<void> {
		if (failed.length === SYSTEM_MEDIA_ASSETS.length) {
			// Nothing landed, so the store is unwritable and a manifest claiming otherwise would make
			// the NEXT boot skip the reads that would have found that out.
			return;
		}
		const manifest: SystemMediaManifest = {
			version: SYSTEM_MEDIA_VERSION,
			seededAt: new Date().toISOString(),
			assets,
		};
		try {
			await this.store.put(
				SYSTEM_MEDIA_MANIFEST_KEY,
				Buffer.from(JSON.stringify(manifest, null, 2)),
				{
					contentType: "application/json",
				},
			);
		} catch (error) {
			logger.warn(
				{ err: describe(error) },
				"could not write the system media manifest; the next boot will re-check every asset",
			);
		}
	}
}

/** Assets are named in the log line, so the message is all a failure needs to carry. */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
