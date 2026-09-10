import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { probeAudio, SAFE_CHANNELS, SAFE_SAMPLE_RATE_HZ } from "../../src/pbx/media/media-audio";
import {
	DEFAULT_MOH_CLASS,
	renderSystemAsset,
	SYSTEM_MEDIA_ASSETS,
	SYSTEM_MEDIA_MANIFEST_KEY,
	SYSTEM_MEDIA_VERSION,
	systemMediaChecksum,
	systemMediaObjectKey,
} from "../../src/pbx/media/system-media";
import { SystemMediaService } from "../../src/pbx/media/system-media.service";
import { LocalObjectStore } from "../../src/storage";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The audio a deployment owns before any tenant configures anything.
 *
 * The defect behind this file is worth restating, because every assertion below is aimed at one
 * half of it: `mediad`'s prompt library IS the object store, nothing ever wrote the platform's own
 * prompts into it, and the result on a live stack was
 * `mediad refused start-playback: no such prompt: sound:moh/default` — a queue caller listening to
 * silence for thirty seconds. So: the catalogue must cover what the engine emits, the bytes must be
 * something a media plane can actually decode, and a second boot must not trample an operator's own
 * recording.
 */
/**
 * A database with no `moh_class` and no `prompt` rows.
 *
 * The seeder reads both to publish tenant hold music under its name; every case in this file is
 * about the PLATFORM's assets, so the two selects answer empty and the publish pass is a no-op.
 * `moh-library.test.ts` is where the tenant half is decided, on the plan rather than the client.
 */
function noMohClasses(): PbxDatabaseClient {
	const select = () => ({ from: () => Object.assign([], { where: () => [] }) });
	return { adminDb: { select } } as unknown as PbxDatabaseClient;
}

describe("system media", () => {
	let root: string;
	let store: LocalObjectStore;
	let service: SystemMediaService;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "system-media-"));
		store = new LocalObjectStore(root);
		service = new SystemMediaService(
			{ PBX_ENSURE_SYSTEM_MEDIA: true, PBX_MEDIA_OBJECT_ROOT: root } as PbxEnv,
			store,
			noMohClasses(),
		);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("ships the default music-on-hold class the engine asks for by default", () => {
		const stems = SYSTEM_MEDIA_ASSETS.map((asset) => asset.stem);
		expect(stems).to.include(`moh/${DEFAULT_MOH_CLASS}`);
		// The stem `mediad`'s `loadMOH` resolves for a caller whose queue names no class. It is the
		// exact string the live failure named, so this is the regression pin.
		expect(systemMediaObjectKey(SYSTEM_MEDIA_ASSETS[0]!)).to.equal("moh/default.wav");
	});

	it("covers every bare sound: stem the engine's own settings name", () => {
		// Read out of `apps/engine/src/routing/plan-walker.ts` (DEFAULT_PLAN_WALKER_SETTINGS) and
		// `apps/engine/src/config/engine-env.ts`. A default the engine gains without an asset here is
		// a prompt that plays as a refusal, which is what this list exists to prevent.
		const required = [
			"unavailable",
			"activated",
			"de-activated",
			"demo-echotest",
			"vm-password",
			"vm-incorrect",
			"vm-rec-name",
			"priv-callerintros",
			"agent-pass",
			"auth-incorrect",
			"auth-thankyou",
			"screen-callee-options",
			"conf-getpin",
			"conf-invalidpin",
			"conf-full",
			"conf-locked",
			"conf-hasjoin",
			"conf-hasleft",
			"dir-intro",
			"dir-instr",
			"dir-nomatch",
			"dir-multi1",
			"dir-multi2",
			// `spellNumber` in plan-walker.ts, which every queue position announcement and every
			// mailbox readback goes through.
			...Array.from({ length: 10 }, (_, digit) => `digits/${digit}`),
		];
		const stems = new Set(SYSTEM_MEDIA_ASSETS.map((asset) => asset.stem));
		for (const stem of required) {
			expect(stems.has(stem), `system media is missing "${stem}"`).to.equal(true);
		}
	});

	it("renders audio the upload policy itself would accept, at the one safe format", () => {
		for (const asset of SYSTEM_MEDIA_ASSETS) {
			const bytes = renderSystemAsset(asset);
			const probe = probeAudio(bytes.subarray(0, 4096));
			expect(probe.format?.extension, asset.stem).to.equal("wav");
			expect(probe.sampleRateHz, asset.stem).to.equal(SAFE_SAMPLE_RATE_HZ);
			expect(probe.channels, asset.stem).to.equal(SAFE_CHANNELS);
			expect(probe.warnings, asset.stem).to.deep.equal([]);
		}
	});

	it("renders audio with energy in it, which is the whole point", () => {
		for (const asset of SYSTEM_MEDIA_ASSETS) {
			const bytes = renderSystemAsset(asset);
			let peak = 0;
			for (let offset = 44; offset + 1 < bytes.length; offset += 2) {
				peak = Math.max(peak, Math.abs(bytes.readInt16LE(offset)));
			}
			expect(peak, `${asset.stem} is silence`).to.be.greaterThan(1000);
		}
	});

	it("renders byte-for-byte identically on every call, so a checksum can be trusted", () => {
		for (const asset of SYSTEM_MEDIA_ASSETS) {
			expect(renderSystemAsset(asset).equals(renderSystemAsset(asset)), asset.stem).to.equal(true);
		}
	});

	it("starts and ends hold music near silence so the loop point does not tick", () => {
		const moh = SYSTEM_MEDIA_ASSETS.find((asset) => asset.loop === true);
		expect(moh).to.not.equal(undefined);
		const bytes = renderSystemAsset(moh!);
		expect(Math.abs(bytes.readInt16LE(44))).to.be.lessThan(2000);
		expect(Math.abs(bytes.readInt16LE(bytes.length - 2))).to.be.lessThan(2000);
	});

	it("seeds every asset on a fresh store and records a manifest", async () => {
		const result = await service.seed();

		expect(result.written).to.have.lengthOf(SYSTEM_MEDIA_ASSETS.length);
		expect(result.failed).to.deep.equal([]);
		for (const asset of SYSTEM_MEDIA_ASSETS) {
			const stat = await store.head(systemMediaObjectKey(asset));
			expect(stat?.sizeBytes, asset.stem).to.be.greaterThan(44);
		}
		const manifest = JSON.parse(
			await readFile(join(root, SYSTEM_MEDIA_MANIFEST_KEY), "utf8"),
		) as Record<string, unknown>;
		expect(manifest.version).to.equal(SYSTEM_MEDIA_VERSION);
		expect(Object.keys(manifest.assets as object)).to.have.lengthOf(SYSTEM_MEDIA_ASSETS.length);
	});

	it("writes nothing on a second boot", async () => {
		await service.seed();
		const second = await service.seed();

		expect(second.written).to.deep.equal([]);
		expect(second.unchanged).to.have.lengthOf(SYSTEM_MEDIA_ASSETS.length);
	});

	it("never overwrites a recording the deployment put there itself", async () => {
		await service.seed();
		const key = systemMediaObjectKey(SYSTEM_MEDIA_ASSETS[1]!);
		const theirs = Buffer.concat([
			renderSystemAsset(SYSTEM_MEDIA_ASSETS[1]!),
			Buffer.from("a real voice-over"),
		]);
		await writeFile(join(root, key), theirs);

		const result = await service.seed();

		expect(result.preserved).to.include(key);
		expect(result.written).to.not.include(key);
		expect(await readFile(join(root, key))).to.deep.equal(theirs);
	});

	it("puts its own asset back when the deployment's file is removed again", async () => {
		await service.seed();
		const key = systemMediaObjectKey(SYSTEM_MEDIA_ASSETS[1]!);
		await writeFile(join(root, key), Buffer.from("theirs"));
		await service.seed();
		await rm(join(root, key));

		const result = await service.seed();

		expect(result.written).to.include(key);
		expect(systemMediaChecksum(await readFile(join(root, key)))).to.equal(
			systemMediaChecksum(renderSystemAsset(SYSTEM_MEDIA_ASSETS[1]!)),
		);
	});

	it("replaces an asset this seeder wrote when the catalogue's bytes change", async () => {
		const key = systemMediaObjectKey(SYSTEM_MEDIA_ASSETS[1]!);
		// An older release's rendering of the same stem: ours, so it is stale rather than foreign.
		const older = renderSystemAsset({
			...SYSTEM_MEDIA_ASSETS[1]!,
			segments: [{ hz: [500], ms: 50 }],
		});
		await store.put(key, older);
		await store.put(
			SYSTEM_MEDIA_MANIFEST_KEY,
			Buffer.from(
				JSON.stringify({
					version: SYSTEM_MEDIA_VERSION,
					seededAt: new Date().toISOString(),
					assets: { [key]: systemMediaChecksum(older) },
				}),
			),
		);

		const result = await service.seed();

		expect(result.written).to.include(key);
		expect(result.preserved).to.not.include(key);
	});

	it("does nothing at all when the deployment turned it off", async () => {
		const off = new SystemMediaService(
			{ PBX_ENSURE_SYSTEM_MEDIA: false, PBX_MEDIA_OBJECT_ROOT: root } as PbxEnv,
			store,
			noMohClasses(),
		);

		await off.onModuleInit();

		expect(await store.head(systemMediaObjectKey(SYSTEM_MEDIA_ASSETS[0]!))).to.equal(undefined);
	});
});
