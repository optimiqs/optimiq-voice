/**
 * What audio the media library accepts, and how it decides.
 *
 * ## The rule: refuse what will not play, rather than store what will not play
 *
 * An uploaded prompt does not end its life in a browser. It ends it in
 * `apps/engine/src/routing/media-refs.ts`, which turns `object://<key>` into
 * `sound:<ENGINE_MEDIA_OBJECT_ROOT>/<key-without-extension>` and hands that to the media server —
 * today Asterisk, over ARI. Asterisk then picks a file itself from whatever formats sit beside
 * that stem. So a file this API cheerfully accepted and the media server cannot decode is not an
 * error anybody sees at upload time: it is **silence on a live call**, discovered by a caller, with
 * nothing in the admin UI to explain it.
 *
 * That asymmetry is why validation here is strict rather than permissive. A refusal at upload is a
 * sentence an admin can act on; a silent accept is an outage with no breadcrumb.
 *
 * ## What Asterisk can actually play off the sounds mount
 *
 * Asterisk's file-format modules cover a lot, but only some of it is present in a default build and
 * only some of that survives a `sound:` lookup by stem:
 *
 * | container / codec              | module            | plays from the mount?                       |
 * | ------------------------------ | ----------------- | ------------------------------------------- |
 * | RIFF/WAVE, PCM signed 16-bit LE | `format_wav`      | **yes** — the universal case                |
 * | RIFF/WAVE, GSM / µ-law / A-law | `format_wav_gsm`  | usually, but build-dependent                |
 * | MP3                            | `format_mp3`      | **not in a default build** (add-on module)  |
 * | Ogg/Vorbis, Opus               | `format_ogg_*`    | build-dependent, frequently absent          |
 * | raw `.ul` / `.al` / `.gsm`     | core              | yes, but they carry no header to validate   |
 *
 * The one row that is true of every deployment is **RIFF/WAVE with 16-bit signed PCM**, and the one
 * sample rate every codec path can reach without a resample is **8 kHz mono** — which is also what
 * `moh_class.sample_rate_hz` defaults to and what `apps/engine` records a voicemail message as.
 *
 * So the policy is:
 *
 * - **WAV (PCM 16-bit) is ACCEPTED** and is the documented safe baseline. 8 kHz mono is what plays
 *   with no conversion anywhere in the stack; other rates and channel counts are accepted with a
 *   {@link AudioProbe.warnings} entry rather than refused, because Asterisk resamples and a
 *   16 kHz mono prompt is a real thing people upload on purpose.
 * - **MP3 is ACCEPTED**, because `format_mp3` is present in the image this repository builds and
 *   because refusing the format every voice-over supplier delivers would make the feature unusable.
 *   It carries a warning naming the module it depends on.
 * - **Everything else is REFUSED**, including WAV whose sample format is not PCM (IEEE float,
 *   ADPCM, GSM-in-WAV), Ogg, FLAC, AAC/M4A and raw headerless audio. Transcoding is recorded as a
 *   follow-up in the module header below rather than faked by accepting the bytes.
 *
 * ## Why magic bytes and not the declared content type
 *
 * The browser's `Content-Type` on a multipart part comes from the operating system's file-type
 * table, which is keyed on the extension. Renaming `payload.exe` to `hold-music.wav` produces a
 * part that says `audio/wav` and contains something else entirely. The declared type is therefore
 * checked FIRST — a cheap early refusal for the obvious case — and then the first bytes are read
 * and must agree. Two checks, and the second one is the one that means something.
 *
 * ## Follow-up, recorded rather than papered over
 *
 * There is no transcoder here and no duration probe worth the name: {@link probeAudio} reports a
 * duration for PCM WAV, where it is arithmetic on the header, and `undefined` for MP3, where it
 * would require frame-walking a variable-bitrate stream. Server-side normalisation (any input →
 * 8 kHz mono PCM WAV, via ffmpeg or a WASM decoder) would remove both the refusals and the
 * warnings, and is the right next step. It is deliberately not attempted here: a half-done
 * transcode that silently resamples badly is worse than a refusal with a reason.
 */

/** A format the media library will store. */
export interface AudioFormat {
	/** The canonical content type stored on the row and returned by the media route. */
	readonly contentType: string;
	/** The extension the object key is given, lower-case, without the dot. */
	readonly extension: string;
	/** Content types a client may declare for this format. */
	readonly declaredTypes: readonly string[];
	/** File-name extensions a client may upload with, lower-case, without the dot. */
	readonly extensions: readonly string[];
}

export const WAV_FORMAT: AudioFormat = {
	contentType: "audio/wav",
	extension: "wav",
	declaredTypes: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
	extensions: ["wav"],
};

export const MP3_FORMAT: AudioFormat = {
	contentType: "audio/mpeg",
	extension: "mp3",
	declaredTypes: ["audio/mpeg", "audio/mp3", "audio/x-mpeg", "audio/mpeg3", "audio/x-mpeg-3"],
	extensions: ["mp3"],
};

export const ACCEPTED_AUDIO_FORMATS: readonly AudioFormat[] = [WAV_FORMAT, MP3_FORMAT];

/** Every content type the upload routes will consider, for the error message and the UI's `accept`. */
export const ACCEPTED_AUDIO_CONTENT_TYPES: readonly string[] = ACCEPTED_AUDIO_FORMATS.flatMap(
	(format) => format.declaredTypes,
);

/** Every extension the upload routes will consider, for the UI's `accept` attribute. */
export const ACCEPTED_AUDIO_EXTENSIONS: readonly string[] = ACCEPTED_AUDIO_FORMATS.flatMap(
	(format) => format.extensions,
);

/**
 * The sample rate and channel count that need no conversion anywhere in the stack.
 *
 * Not enforced — see the module header. A prompt outside them is stored with a warning, because a
 * resample on the media server is a real cost and an admin is entitled to know they are paying it,
 * but it is not a reason to refuse a file that will play.
 */
export const SAFE_SAMPLE_RATE_HZ = 8_000;
export const SAFE_CHANNELS = 1;

/** WAV's `wFormatTag` for signed 16-bit little-endian PCM — the one value Asterisk always reads. */
const WAVE_FORMAT_PCM = 1;
/** `WAVE_FORMAT_EXTENSIBLE`; its real format lives in the sub-format GUID's first two bytes. */
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const PCM_BITS_PER_SAMPLE = 16;

/** Enough bytes to reach a WAV `fmt ` chunk past a couple of unexpected chunks. */
export const AUDIO_PROBE_BYTES = 4_096;

/** What the sniffer concluded. `format === undefined` means "refuse, and here is why". */
export interface AudioProbe {
	readonly format?: AudioFormat;
	/** Why the bytes were refused. Present exactly when `format` is absent. */
	readonly issue?: string;
	/** Non-fatal observations worth surfacing to the admin who uploaded the file. */
	readonly warnings: readonly string[];
	readonly sampleRateHz?: number;
	readonly channels?: number;
	/** Only computed where it is arithmetic rather than a decode. See the module header. */
	readonly durationMs?: number;
}

/**
 * Whether a client's DECLARED content type is one this library considers at all.
 *
 * The cheap gate, run before any bytes are buffered, so an obviously wrong upload is refused
 * without spending the size cap on it. Never the last word — {@link probeAudio} is.
 *
 * A part with no declared type at all is allowed through to the sniffer: `curl -F` and several
 * HTTP clients send `application/octet-stream` or nothing, and refusing them would make the
 * endpoint unusable from a shell for a check the magic bytes perform properly anyway.
 */
export function isPlausibleAudioContentType(declared: string | undefined): boolean {
	const value = declared?.split(";")[0]?.trim().toLowerCase();
	if (value === undefined || value === "" || value === "application/octet-stream") {
		return true;
	}
	return ACCEPTED_AUDIO_CONTENT_TYPES.includes(value);
}

/**
 * Identifies audio from its first bytes.
 *
 * Reads only the header — {@link AUDIO_PROBE_BYTES} is ample for a WAV `fmt ` chunk and for an MP3
 * frame sync — so it may be handed a prefix rather than the whole file.
 */
export function probeAudio(head: Buffer): AudioProbe {
	if (head.length < 12) {
		return { issue: "the file is too short to be audio", warnings: [] };
	}
	if (
		head.subarray(0, 4).toString("latin1") === "RIFF" &&
		head.subarray(8, 12).toString("latin1") === "WAVE"
	) {
		return probeWav(head);
	}
	if (isMp3(head)) {
		return {
			format: MP3_FORMAT,
			warnings: [
				"MP3 playback depends on the media server's `format_mp3` module, which is not part of " +
					"a default Asterisk build. WAV (16-bit PCM, 8 kHz mono) is the format that plays " +
					"on every deployment.",
			],
		};
	}
	return { issue: describeRefusal(head), warnings: [] };
}

/**
 * The WAV branch: find `fmt `, read the four fields that decide playability.
 *
 * The chunk walk is bounded and never trusts a declared chunk size to be sane — a crafted `RIFF`
 * with a 4 GiB chunk length must not send this into a long loop or past the end of the buffer.
 */
function probeWav(head: Buffer): AudioProbe {
	let offset = 12;
	while (offset + 8 <= head.length) {
		const chunkId = head.subarray(offset, offset + 4).toString("latin1");
		const chunkSize = head.readUInt32LE(offset + 4);
		const body = offset + 8;

		if (chunkId === "fmt ") {
			if (body + 16 > head.length) {
				return { issue: "the WAV header is truncated", warnings: [] };
			}
			const formatTag = head.readUInt16LE(body);
			const channels = head.readUInt16LE(body + 2);
			const sampleRateHz = head.readUInt32LE(body + 4);
			const bitsPerSample = head.readUInt16LE(body + 14);

			const effectiveTag =
				formatTag === WAVE_FORMAT_EXTENSIBLE && body + 26 <= head.length
					? head.readUInt16LE(body + 24)
					: formatTag;

			if (effectiveTag !== WAVE_FORMAT_PCM || bitsPerSample !== PCM_BITS_PER_SAMPLE) {
				return {
					issue:
						"this WAV is not 16-bit PCM. The media server reads RIFF/WAVE with signed " +
						"16-bit little-endian samples; re-export the file as PCM 16-bit " +
						`(this one declares format ${String(effectiveTag)} at ${String(bitsPerSample)}-bit).`,
					warnings: [],
				};
			}
			if (channels === 0 || sampleRateHz === 0) {
				return { issue: "this WAV declares no channels or no sample rate", warnings: [] };
			}

			const warnings: string[] = [];
			if (sampleRateHz !== SAFE_SAMPLE_RATE_HZ) {
				warnings.push(
					`This file is ${String(sampleRateHz)} Hz. It will play, but the media server ` +
						`resamples it on every call; ${String(SAFE_SAMPLE_RATE_HZ)} Hz needs no conversion.`,
				);
			}
			if (channels !== SAFE_CHANNELS) {
				warnings.push(
					`This file has ${String(channels)} channels. A call is mono, so the extra ` +
						"channels are mixed down on every play; export mono to avoid it.",
				);
			}

			return {
				format: WAV_FORMAT,
				warnings,
				sampleRateHz,
				channels,
				...(durationOfPcm(head, sampleRateHz, channels) === undefined
					? {}
					: { durationMs: durationOfPcm(head, sampleRateHz, channels) }),
			};
		}

		if (chunkSize === 0 || chunkSize > head.length) {
			break;
		}
		// Chunks are word-aligned: an odd size is followed by one pad byte.
		offset = body + chunkSize + (chunkSize % 2);
	}
	return { issue: "this WAV has no readable `fmt ` header", warnings: [] };
}

/**
 * The `data` chunk's declared length turned into milliseconds.
 *
 * Read from the HEADER rather than measured off the file, and therefore only trusted when the
 * declared length is plausible: a `data` size of zero (some encoders write it and fix it up later)
 * or one that the probe window cannot corroborate yields `undefined`, which every consumer renders
 * as "unknown" rather than as "zero seconds".
 */
function durationOfPcm(head: Buffer, sampleRateHz: number, channels: number): number | undefined {
	let offset = 12;
	while (offset + 8 <= head.length) {
		const chunkId = head.subarray(offset, offset + 4).toString("latin1");
		const chunkSize = head.readUInt32LE(offset + 4);
		if (chunkId === "data") {
			if (chunkSize === 0) {
				return undefined;
			}
			const bytesPerFrame = (PCM_BITS_PER_SAMPLE / 8) * channels;
			return Math.round((chunkSize / bytesPerFrame / sampleRateHz) * 1000);
		}
		if (chunkSize === 0 || chunkSize > head.length) {
			return undefined;
		}
		offset = offset + 8 + chunkSize + (chunkSize % 2);
	}
	return undefined;
}

/**
 * MP3: an ID3v2 tag, or a frame sync.
 *
 * `FF Ex`/`FF Fx` is the sync word plus a valid MPEG version/layer pair. Checked rather than
 * assumed because `FF` alone is one byte in 256 and would make this function say yes to noise.
 */
function isMp3(head: Buffer): boolean {
	if (head.subarray(0, 3).toString("latin1") === "ID3") {
		return true;
	}
	const first = head[0];
	const second = head[1];
	if (first !== 0xff || second === undefined) {
		return false;
	}
	// Sync is 11 set bits; the next two are the MPEG version (`01` is reserved) and the next two
	// the layer (`00` is reserved).
	if ((second & 0xe0) !== 0xe0) {
		return false;
	}
	const version = (second & 0x18) >> 3;
	const layer = (second & 0x06) >> 1;
	return version !== 0b01 && layer !== 0b00;
}

/** Names the format we found, when we can, so the refusal says something actionable. */
function describeRefusal(head: Buffer): string {
	const magic = head.subarray(0, 4).toString("latin1");
	const named =
		magic === "OggS"
			? "Ogg (Vorbis or Opus)"
			: magic === "fLaC"
				? "FLAC"
				: head.subarray(4, 8).toString("latin1") === "ftyp"
					? "MP4/M4A/AAC"
					: magic.startsWith("PK")
						? "a ZIP archive"
						: undefined;
	const prefix =
		named === undefined
			? "This file is not audio the media server can play"
			: `This file is ${named}`;
	return (
		`${prefix}. Upload WAV (16-bit PCM, ideally ${String(SAFE_SAMPLE_RATE_HZ)} Hz mono) or MP3 — ` +
		"nothing else is stored, because a file the media server cannot decode plays as silence on a live call."
	);
}

/** The extension a stored object gets, from the format the sniffer identified. */
export function extensionFor(format: AudioFormat): string {
	return format.extension;
}

/**
 * The content type to serve a stored object with, from its key.
 *
 * Derived from the key rather than read from the row so the media route can answer for a key
 * whatever table it came from, exactly as the recordings and voicemail routes already do.
 */
export function contentTypeForKey(objectKey: string): string {
	const lower = objectKey.toLowerCase();
	for (const format of ACCEPTED_AUDIO_FORMATS) {
		if (format.extensions.some((extension) => lower.endsWith(`.${extension}`))) {
			return format.contentType;
		}
	}
	return "application/octet-stream";
}
