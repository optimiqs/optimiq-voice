import { createRequire } from "node:module";
import { Readable } from "stream";
import { getLogger } from "@optimiq-voice/logger";
import { streamToBuffer } from "./streamToBuffer";
import type * as Wavefile from "wavefile";

/**
 * `wavefile` is CommonJS-only and assigns its exports in a shape Node's CJS named-export
 * detection cannot see — `await import("wavefile")` yields `{ default }` and nothing else, and a
 * default import does not statically exist either. `createRequire` gets the real `module.exports`
 * without guessing at an interop shape.
 */
const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof Wavefile;

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * Converts a ulaw stream to PCM 16-bit at 8kHz
 *
 * @param readableStream - The input ulaw audio stream to convert
 * @returns A Promise that resolves to a Buffer containing PCM 16-bit audio data at 8kHz
 */
export async function convertUlawToPCM16(readableStream: Readable): Promise<Buffer> {
	try {
		const inputBuffer = await streamToBuffer(readableStream);
		const wav = new WaveFile();

		wav.fromScratch(1, 8000, "8m", inputBuffer);
		wav.fromMuLaw();

		const waveBuffer = wav.toBuffer();

		return Buffer.from(waveBuffer.buffer, waveBuffer.byteOffset + 44, waveBuffer.byteLength - 44);
	} catch (error) {
		logger.error(`error converting audio format: ${error.message}`, {
			stack: error.stack,
		});
		throw new Error(`Audio conversion failed: ${error.message}`);
	}
}
