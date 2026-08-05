import { AbstractSpeechToText } from "../stt/AbstractSpeechToText";
import { AbstractTextToSpeech } from "../tts/AbstractTextToSpeech";

type IntegrationsContainer = {
	ref: string;
	accessKeyId: string;
	endpoint: string;
	tts: AbstractTextToSpeech<unknown>;
	stt: AbstractSpeechToText<unknown>;
};

type CreateContainer = (appRef: string) => Promise<IntegrationsContainer>;

export { type CreateContainer, type IntegrationsContainer };
