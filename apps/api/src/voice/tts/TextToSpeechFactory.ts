import { getLogger } from "@optimiq-voice/logger";
import { AbstractTextToSpeech } from "./AbstractTextToSpeech";
import { Azure, ENGINE_NAME as AZURE_ENGINE_NAME } from "./Azure";
import { Deepgram, ENGINE_NAME as DEEPGRAM_ENGINE_NAME } from "./Deepgram";
import { ENGINE_NAME as ELEVEN_LABS_ENGINE_NAME, ElevenLabs } from "./ElevenLabs";
import { Google, ENGINE_NAME as GOOGLE_ENGINE_NAME } from "./Google";

const logger = getLogger({ service: "api", filePath: __filename });

type EngineConstructor<T> = new (options: T) => AbstractTextToSpeech<string>;

class TextToSpeechFactory {
	private static readonly engines: Map<string, EngineConstructor<unknown>> = new Map();

	static registerEngine<T>(name: string, ctor: EngineConstructor<T>) {
		logger.verbose("registering tts engine", { name });
		this.engines.set(name, ctor);
	}

	static getEngine<T>(engineName: string, config: T): AbstractTextToSpeech<string> {
		const EngineConstructor = this.engines.get(engineName);
		if (!EngineConstructor) {
			throw new Error(`Engine ${engineName} not found`);
		}
		return new EngineConstructor(config);
	}
}

// Register engines
TextToSpeechFactory.registerEngine(GOOGLE_ENGINE_NAME, Google);
TextToSpeechFactory.registerEngine(AZURE_ENGINE_NAME, Azure);
TextToSpeechFactory.registerEngine(DEEPGRAM_ENGINE_NAME, Deepgram);
TextToSpeechFactory.registerEngine(ELEVEN_LABS_ENGINE_NAME, ElevenLabs);

export { TextToSpeechFactory };
