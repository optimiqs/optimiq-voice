import { Readable } from "stream";
import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import * as z from "zod";
import { AzureVoice } from "@optimiq-voice/common";
import { AbstractTextToSpeech } from "./AbstractTextToSpeech";
import { AzureTTSConfig, SynthOptions } from "./types";
import { createChunkedSynthesisStream } from "./utils/createChunkedSynthesisStream";
import { isSsml } from "./utils/isSsml";

const ENGINE_NAME = "tts.azure";

class Azure extends AbstractTextToSpeech<typeof ENGINE_NAME> {
	config: AzureTTSConfig;
	readonly engineName = ENGINE_NAME;
	protected readonly OUTPUT_FORMAT = "sln16";
	protected readonly CACHING_FIELDS = ["voice"];

	constructor(config: AzureTTSConfig) {
		super();
		this.config = config;
	}

	synthesize(text: string, options: SynthOptions): { ref: string; stream: Readable } {
		this.logSynthesisRequest(text, options);

		const ref = this.createMediaReference();
		const { subscriptionKey, serviceRegion } = this.config.credentials;
		const voice = options.voice || this.config.config.voice;
		const speechConfig = sdk.SpeechConfig.fromSubscription(subscriptionKey, serviceRegion);
		speechConfig.speechSynthesisVoiceName = voice;
		speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw8Khz16BitMonoPcm;

		const stream = createChunkedSynthesisStream(text, async (chunkText) => {
			const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
			const isSSML = isSsml(chunkText);
			const func = isSSML ? "speakSsmlAsync" : "speakTextAsync";

			try {
				const audioData = await new Promise<Buffer>((resolve, reject) => {
					const audioChunks: Buffer[] = [];

					synthesizer[func](
						chunkText,
						(result) => {
							if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
								audioChunks.push(Buffer.from(result.audioData));
								resolve(Buffer.concat(audioChunks));
							} else {
								reject(new Error("Speech synthesis canceled: " + result.errorDetails));
							}
							synthesizer.close();
						},
						(err: string) => {
							synthesizer.close();
							reject(new Error(err));
						},
					);
				});

				// Ignore the first 44 bytes of the response to avoid the WAV header
				return audioData.subarray(44);
			} catch (error) {
				// Make sure synthesizer is closed in case of error
				synthesizer.close();
				throw error;
			}
		});

		return { ref, stream };
	}

	static getConfigValidationSchema(): z.Schema {
		return z.object({
			voice: z.nativeEnum(AzureVoice, { message: "Invalid Azure voice" }),
		});
	}

	static getCredentialsValidationSchema(): z.Schema {
		return z.object({
			subscriptionKey: z.string(),
			serviceRegion: z.string(),
		});
	}
}

export { Azure, ENGINE_NAME };
