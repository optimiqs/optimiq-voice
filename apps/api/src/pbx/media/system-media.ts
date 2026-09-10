/**
 * The audio a deployment has to own before any tenant configures anything.
 *
 * ## The gap this closes
 *
 * A routing artifact names two kinds of audio. TENANT audio — an IVR greeting, a hold-music class —
 * is uploaded through `prompts.service.ts` and addressed by object key. SYSTEM audio is not: the
 * engine's own settings carry bare stems (`sound:unavailable`, `sound:vm-password`,
 * `sound:digits/7`) and `mediad` resolves a music class with no name as `moh:default`. Nothing ever
 * put those files anywhere. On Asterisk that was invisible, because its core sound package ships
 * every one of those stems; on `mediad`, whose library is exactly the object store and nothing
 * else, the result is `no such prompt: sound:moh/default` — a queue caller listening to silence and
 * an IVR whose greeting never plays.
 *
 * So a deployment now seeds them. {@link SYSTEM_MEDIA_ASSETS} is the catalogue, keyed by the stem
 * the engine actually emits, and {@link renderSystemAsset} is the bytes.
 *
 * ## Why tones and not speech
 *
 * There is no text-to-speech renderer on this platform (`media-refs.ts` says so, and refuses
 * `tts://` for the same reason), and no free prompt pack can be vendored without taking on its
 * licence. The choice is therefore between shipping nothing — silence, the defect this exists to
 * remove — and shipping DETERMINISTIC TONES that are audible, distinguishable, and obviously
 * placeholders.
 *
 * Tones win, on one argument: every failure these prompts guard is a BRANCH, and a branch is
 * testable only if the caller can hear that it was taken. A distinct rising pair for "activated"
 * and a falling pair for "de-activated" tell an operator which way a feature code went; ten
 * single-frequency digits make a queue position readable by anyone with a tuner; silence tells
 * nobody anything. An operator replaces any of them by dropping a real recording at the same stem —
 * the seeder never overwrites a file whose checksum is not one it wrote (see
 * `system-media.service.ts`), so a prompt pack installed by hand survives every restart.
 *
 * ## The format, and why there is no choice in it
 *
 * RIFF/WAVE, 16-bit signed PCM, 8 kHz, mono — {@link SAFE_SAMPLE_RATE_HZ} and
 * {@link SAFE_CHANNELS}, the one row of `media-audio.ts`'s format table that is true of every
 * deployment. It is also the only container `mediad` reads (`internal/audio/wav.go`) and the rate
 * G.711 needs with no resample, so these files reach a caller's ear without a conversion anywhere.
 *
 * Every render is byte-for-byte reproducible from this file: same catalogue, same bytes, same
 * checksum, on every machine. That is what lets the seeder tell "the asset this version ships" from
 * "something an operator put here" by comparing a hash rather than a timestamp.
 */

import { createHash } from "node:crypto";
import { SAFE_CHANNELS, SAFE_SAMPLE_RATE_HZ } from "./media-audio";
import { MEDIA_KEY_PREFIXES } from "./media-storage";

/**
 * Bumped when the CATALOGUE changes — an asset added, removed, or re-voiced.
 *
 * It is written into the manifest so a deployment upgrading to a release with new system audio
 * seeds the additions on its next boot without an operator step. It is not a checksum: the seeder
 * compares those per asset, and this only decides whether the manifest is worth re-reading.
 */
export const SYSTEM_MEDIA_VERSION = 2;

/** Where the manifest of what was seeded lives, relative to the object root. */
export const SYSTEM_MEDIA_MANIFEST_KEY = "system-media.json";

/** The class `mediad` resolves a `moh:` reference with no name to, and Asterisk's own default. */
export const DEFAULT_MOH_CLASS = "default";

/**
 * One synthesised prompt.
 *
 * `segments` are played in order with no gap between them, so a two-segment asset is one prompt
 * that changes pitch rather than two prompts a caller hears as separate events. `loop` marks the
 * assets a media plane repeats — only hold music today — and exists so the renderer can make the
 * clip's end meet its start at a zero crossing.
 */
export interface SystemMediaAsset {
	/** The stem the engine emits, WITHOUT the extension, relative to the object root. */
	readonly stem: string;
	/** What it is, for the boot log and for an operator reading the manifest. */
	readonly description: string;
	readonly segments: readonly SystemMediaSegment[];
	readonly loop?: boolean;
}

/** A constant-amplitude segment: one or more frequencies summed, or silence when `hz` is empty. */
export interface SystemMediaSegment {
	readonly hz: readonly number[];
	readonly ms: number;
	/** 0…1 of full scale. Kept well below 1 so a summed two-tone segment cannot clip. */
	readonly gain?: number;
}

/** A short mid-range acknowledgement, the shape most of the catalogue is built from. */
function beep(hz: number, ms = 220): SystemMediaSegment {
	return { hz: [hz], ms };
}

function gap(ms: number): SystemMediaSegment {
	return { hz: [], ms };
}

/**
 * The digit prompts, `digits/0` … `digits/9`.
 *
 * One frequency per digit, rising monotonically, so a spelled number is heard as a rising or
 * falling run rather than a row of identical beeps. The range is 520–970 Hz: inside every codec's
 * passband, above the 300 Hz floor a phone speaker rolls off at, and clear of the DTMF grid so a
 * detector never mistakes a position announcement for a keypress.
 */
const DIGIT_ASSETS: readonly SystemMediaAsset[] = Array.from({ length: 10 }, (_, digit) => ({
	stem: `digits/${digit}`,
	description: `the digit ${digit}`,
	segments: [beep(520 + digit * 50, 260), gap(120)],
}));

/**
 * Everything a stock plan can name.
 *
 * The stems are not invented here: each one is a default in `apps/engine`
 * (`DEFAULT_PLAN_WALKER_SETTINGS` and `config/engine-env.ts`), which took them from Asterisk's core
 * sound package. Keeping the same names is what lets one deployment run either media plane — on
 * Asterisk these files sit beside the packaged ones and are never reached, because Asterisk
 * resolves its own sounds directory first.
 *
 * A pair of tones is the vocabulary: RISING means the thing succeeded or is open, FALLING means it
 * did not, and a three-tone descent is terminal.
 */
export const SYSTEM_MEDIA_ASSETS: readonly SystemMediaAsset[] = [
	{
		stem: `${MEDIA_KEY_PREFIXES.moh}/${DEFAULT_MOH_CLASS}`,
		description: "the default music-on-hold class",
		// Eight seconds of a slow four-note figure at low gain. Long enough not to grate on a caller
		// who waits a minute, short enough that the loop point is provable in a test.
		segments: [
			{ hz: [440], ms: 900, gain: 0.16 },
			{ hz: [554], ms: 900, gain: 0.16 },
			{ hz: [659], ms: 900, gain: 0.16 },
			{ hz: [554], ms: 900, gain: 0.16 },
			{ hz: [440], ms: 900, gain: 0.14 },
			{ hz: [349], ms: 900, gain: 0.14 },
			{ hz: [392], ms: 900, gain: 0.14 },
			{ hz: [440], ms: 1700, gain: 0.14 },
		],
		loop: true,
	},
	{
		stem: "unavailable",
		description: "the announcement a plan falls back to when nothing else can be played",
		segments: [beep(660, 300), gap(120), beep(520, 300), gap(120), beep(400, 500)],
	},
	{
		stem: "activated",
		description: "a feature code turned something on",
		segments: [beep(600), gap(80), beep(900)],
	},
	{
		stem: "de-activated",
		description: "a feature code turned something off",
		segments: [beep(900), gap(80), beep(600)],
	},
	{
		stem: "demo-echotest",
		description: "the echo test is starting",
		segments: [beep(800, 160), gap(80), beep(800, 160), gap(80), beep(800, 160)],
	},
	{
		stem: "vm-password",
		description: "enter your mailbox PIN",
		segments: [beep(700, 260), gap(100), beep(700, 260)],
	},
	{
		stem: "vm-incorrect",
		description: "that PIN was wrong",
		segments: [beep(420, 400), gap(100), beep(330, 400)],
	},
	{
		/**
		 * The recording-consent announcement — "this call may be recorded".
		 *
		 * The only stem in this catalogue a caller hears for a LEGAL reason rather than an
		 * operational one, and the one an operator is most likely to replace, because a tone cannot
		 * say what a jurisdiction requires be said. It is seeded anyway, on the argument the header
		 * makes: the alternative to a placeholder is silence, and a consent gate that announces
		 * silence is a gate that records the call while telling the caller nothing — worse than the
		 * defect, not better than it. Three rising tones, deliberately unlike any acknowledgement in
		 * the catalogue, so an operator listening to a test call can hear that the gate fired.
		 *
		 * `call-control.ts` plays it as `sound:recording-consent` whenever the tenant names no prompt
		 * of their own, and the seeder leaves an operator's own file at this key alone forever.
		 */
		stem: "recording-consent",
		description: "this call may be recorded",
		segments: [beep(520, 260), gap(90), beep(650, 260), gap(90), beep(820, 340)],
	},
	{
		stem: "vm-rec-name",
		description: "record your name after the tone",
		segments: [beep(760, 200), gap(80), beep(1000, 300)],
	},
	{
		stem: "priv-callerintros",
		description: "the recorded caller introduction is about to play",
		segments: [beep(620, 200), gap(80), beep(780, 200)],
	},
	{
		stem: "agent-pass",
		description: "enter your outbound-calling PIN",
		segments: [beep(680, 260), gap(100), beep(680, 260)],
	},
	{
		stem: "auth-incorrect",
		description: "that outbound-calling PIN was wrong",
		segments: [beep(430, 400), gap(100), beep(340, 400)],
	},
	{
		stem: "auth-thankyou",
		description: "out of PIN attempts; the call is ending",
		segments: [beep(430, 300), gap(90), beep(360, 300), gap(90), beep(290, 500)],
	},
	{
		stem: "screen-callee-options",
		description: "press 1 to accept this screened call",
		segments: [beep(720, 220), gap(90), beep(880, 220), gap(90), beep(720, 220)],
	},
	{
		stem: "conf-getpin",
		description: "enter the conference PIN",
		segments: [beep(640, 260), gap(100), beep(640, 260)],
	},
	{
		stem: "conf-invalidpin",
		description: "that conference PIN was wrong",
		segments: [beep(410, 400), gap(100), beep(320, 400)],
	},
	{
		stem: "conf-full",
		description: "the conference room is full",
		segments: [beep(500, 250), gap(90), beep(500, 250), gap(90), beep(390, 450)],
	},
	{
		stem: "conf-locked",
		description: "the conference room is locked",
		segments: [beep(460, 450), gap(120), beep(460, 450)],
	},
	{
		stem: "conf-hasjoin",
		description: "a participant joined the conference",
		segments: [beep(700, 180), gap(70), beep(940, 180)],
	},
	{
		stem: "conf-hasleft",
		description: "a participant left the conference",
		segments: [beep(940, 180), gap(70), beep(700, 180)],
	},
	{
		stem: "dir-intro",
		description: "welcome to the dial-by-name directory",
		segments: [beep(600, 200), gap(80), beep(750, 200), gap(80), beep(900, 260)],
	},
	{
		stem: "dir-instr",
		description: "spell the name you want, then press pound",
		segments: [beep(750, 220), gap(90), beep(600, 220)],
	},
	{
		stem: "dir-nomatch",
		description: "no directory entry matched",
		segments: [beep(440, 350), gap(100), beep(350, 350)],
	},
	{
		stem: "dir-multi1",
		description: "several entries matched; press 1 for",
		segments: [beep(680, 200), gap(80), beep(820, 200)],
	},
	{
		stem: "dir-multi2",
		description: "…to reach that entry",
		segments: [beep(820, 200), gap(80), beep(680, 200)],
	},
	...DIGIT_ASSETS,
];

/** The stem an asset is stored under, with the extension every media plane expects. */
export function systemMediaObjectKey(asset: SystemMediaAsset): string {
	return `${asset.stem}.wav`;
}

const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
const WAVE_FORMAT_PCM = 1;
const DEFAULT_GAIN = 0.3;
/**
 * How long a segment's edges are ramped, in samples.
 *
 * A tone that starts and stops at full amplitude carries a step discontinuity, which G.711 encodes
 * faithfully and a caller hears as a click on every segment boundary. 4 ms at 8 kHz is 32 samples —
 * long enough to remove the click, short enough that a 160 ms beep is still a beep.
 */
const EDGE_RAMP_SAMPLES = 32;

/**
 * One asset's bytes: an 8 kHz mono 16-bit PCM RIFF/WAVE file, identical on every run.
 *
 * A looping asset is trimmed to a whole number of samples and both its edges are ramped, so the
 * clip's end meets its start silently — `mediad` restarts a looping source at sample zero with no
 * crossfade, and an unramped loop point is an audible tick once every pass.
 */
export function renderSystemAsset(asset: SystemMediaAsset): Buffer {
	const samples: number[] = [];
	for (const segment of asset.segments) {
		const count = Math.max(0, Math.round((segment.ms * SAFE_SAMPLE_RATE_HZ) / 1000));
		const gain = segment.gain ?? DEFAULT_GAIN;
		for (let index = 0; index < count; index += 1) {
			samples.push(segment.hz.length === 0 ? 0 : sample(segment.hz, gain, index, count));
		}
	}

	const bytes = Buffer.alloc(WAV_HEADER_BYTES + samples.length * BYTES_PER_SAMPLE);
	const dataBytes = samples.length * BYTES_PER_SAMPLE;
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(36 + dataBytes, 4);
	bytes.write("WAVE", 8, "ascii");
	bytes.write("fmt ", 12, "ascii");
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(WAVE_FORMAT_PCM, 20);
	bytes.writeUInt16LE(SAFE_CHANNELS, 22);
	bytes.writeUInt32LE(SAFE_SAMPLE_RATE_HZ, 24);
	bytes.writeUInt32LE(SAFE_SAMPLE_RATE_HZ * SAFE_CHANNELS * BYTES_PER_SAMPLE, 28);
	bytes.writeUInt16LE(SAFE_CHANNELS * BYTES_PER_SAMPLE, 32);
	bytes.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
	bytes.write("data", 36, "ascii");
	bytes.writeUInt32LE(dataBytes, 40);
	for (let index = 0; index < samples.length; index += 1) {
		bytes.writeInt16LE(samples[index] as number, WAV_HEADER_BYTES + index * BYTES_PER_SAMPLE);
	}
	return bytes;
}

/** One sample of a summed sine set, edge-ramped, as a 16-bit signed integer. */
function sample(hz: readonly number[], gain: number, index: number, count: number): number {
	let value = 0;
	for (const frequency of hz) {
		value += Math.sin((2 * Math.PI * frequency * index) / SAFE_SAMPLE_RATE_HZ);
	}
	const ramp = Math.min(
		1,
		(index + 1) / EDGE_RAMP_SAMPLES,
		Math.max(0, count - index) / EDGE_RAMP_SAMPLES,
	);
	const scaled = (value / hz.length) * gain * ramp * 32_767;
	return Math.max(-32_768, Math.min(32_767, Math.round(scaled)));
}

/** The checksum the manifest records, so an operator's own recording is never overwritten. */
export function systemMediaChecksum(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** What {@link SYSTEM_MEDIA_MANIFEST_KEY} holds. */
export interface SystemMediaManifest {
	readonly version: number;
	readonly seededAt: string;
	/** Object key → the checksum of the bytes THIS seeder wrote there. */
	readonly assets: Readonly<Record<string, string>>;
}
