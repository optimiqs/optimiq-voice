import { getLogger } from "@optimiq-voice/logger";
import { createVad } from "./createVad";
import { Vad } from "./types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

class SileroVad implements Vad {
	private vad: (data: Uint8Array, callback: (event: string) => void) => void;
	private readonly params: {
		pathToModel: string;
		activationThreshold: number;
		deactivationThreshold: number;
		debounceFrames: number;
	};

	constructor(params: {
		pathToModel: string;
		activationThreshold: number;
		deactivationThreshold: number;
		debounceFrames: number;
	}) {
		logger.verbose("starting instance of silero vad v5", { ...params });
		this.params = params;
	}

	pathToModel: string;
	activationThreshold: number;
	deactivationThreshold: number;
	debounceFrames: number;

	async init() {
		this.vad = await createVad(this.params);
	}

	processChunk(data: Uint8Array, callback: (event: "SPEECH_START" | "SPEECH_END") => void) {
		if (!this.vad) {
			throw new Error("VAD not initialized");
		}
		this.vad(data, callback);
	}
}

export { SileroVad };
