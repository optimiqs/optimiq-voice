import { VerbRequest } from "./Verb";

enum PlaybackControlAction {
	STOP = "STOP",
	RESTART = "RESTART",
	PAUSE = "PAUSE",
	UNPAUSE = "UNPAUSE",
	FORWARD = "FORWARD",
}

type PlaybackControlRequest = VerbRequest & {
	playbackRef: string;
	action: PlaybackControlAction;
};

export { PlaybackControlAction, PlaybackControlRequest };
