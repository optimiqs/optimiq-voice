import { z } from "zod";
import { Messages, PlaybackControlAction, PlaybackControlRequest } from "@optimiq-voice/common";
import { Verb } from "./Verb";

class PlaybackControl extends Verb<PlaybackControlRequest> {
	getValidationSchema(): z.Schema {
		return z.object({
			playbackRef: z.string().uuid({ message: Messages.VALID_UUID }),
			action: z.nativeEnum(PlaybackControlAction, {
				message: "Invalid playback control action",
			}),
		});
	}
}

export { PlaybackControl };
