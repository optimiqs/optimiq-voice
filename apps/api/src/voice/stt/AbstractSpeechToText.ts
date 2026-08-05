import { Stream } from "stream";
import * as z from "zod";
import { MethodNotImplementedError } from "../errors/MethodNotImplementedError";
import { SpeechToText } from "../types";
import { SpeechResult, StreamSpeech, SttConfig } from "./types";

abstract class AbstractSpeechToText<E, T extends SttConfig = SttConfig> implements SpeechToText {
	abstract readonly engineName: E;
	config: T;

	constructor(config: T) {
		this.config = config;
	}

	abstract streamTranscribe(stream: Stream): StreamSpeech;

	abstract transcribe(stream: Stream): Promise<SpeechResult>;

	getName(): E {
		return this.engineName;
	}

	static getConfigValidationSchema(): z.Schema {
		throw new MethodNotImplementedError();
	}

	static getCredentialsValidationSchema(): z.Schema {
		throw new MethodNotImplementedError();
	}
}

export { AbstractSpeechToText };
