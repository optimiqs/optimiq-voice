type VadEvent = "SPEECH_START" | "SPEECH_END";

type Vad = {
	processChunk: (chunk: Uint8Array, callback: (event: VadEvent) => void) => void;
};

type VadParams = {
	pathToModel?: string;
	activationThreshold: number;
	deactivationThreshold: number;
	debounceFrames: number;
};

export interface SpeechProbabilities {
	notSpeech: number;
	isSpeech: number;
}

export interface ONNXRuntimeAPI {
	InferenceSession: {
		create: (
			modelPath: ArrayBuffer | string,
			options?: {
				interOpNumThreads: number;
				intraOpNumThreads: number;
				enableCpuMemArena: boolean;
			},
		) => Promise<ONNXSession>;
	};
	Tensor: new (type: string, data: Float32Array | bigint[], dims: number[]) => ONNXTensor;
}

export interface ONNXSession {
	run: (feeds: { [key: string]: ONNXTensor }) => Promise<{
		output: { data: Float32Array };
		stateN: ONNXTensor;
	}>;
	inputNames: string[];
	outputNames: string[];
}

export interface ONNXTensor {
	data: Float32Array | bigint[];
	dims: number[];
	type: string;
}

export { Vad, VadEvent, VadParams };
