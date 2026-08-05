import { Readable } from "stream";
import { WaveFile } from "wavefile";
import { getLogger } from "@optimiq-voice/logger";
import { streamToBuffer } from "./streamToBuffer";

const logger = getLogger({ service: "api", filePath: __filename });

/**
 * Converts a ulaw stream to PCM 16-bit at 8kHz
 *
 * @param readableStream - The input ulaw audio stream to convert
 * @returns A Promise that resolves to a Buffer containing PCM 16-bit audio data at 8kHz
 */
export async function convertUlawToPCM16(
  readableStream: Readable
): Promise<Buffer> {
  try {
    const inputBuffer = await streamToBuffer(readableStream);
    const wav = new WaveFile();

    wav.fromScratch(1, 8000, "8m", inputBuffer);
    wav.fromMuLaw();

    const waveBuffer = wav.toBuffer();

    return Buffer.from(
      waveBuffer.buffer,
      waveBuffer.byteOffset + 44,
      waveBuffer.byteLength - 44
    );
  } catch (error) {
    logger.error(`error converting audio format: ${error.message}`, {
      stack: error.stack
    });
    throw new Error(`Audio conversion failed: ${error.message}`);
  }
}
