import { VerbRequest } from "./Verb";

type PlayOptions = {
	playbackRef?: string;
};

type PlayRequest = VerbRequest & { url: string } & PlayOptions;

type PlayResponse = {
	mediaSessionRef: string;
	playbackRef: string;
};

export { PlayOptions, PlayRequest, PlayResponse };
