import { Client } from "ari-client";
import { AriEvent } from "../../types";

const awaitForPlaybackFinished = async (ari: Client, playbackRef: string): Promise<void> => {
	return new Promise((resolve) => {
		const listener = (_: unknown, playback: { id: string }) => {
			if (playbackRef === playback.id) {
				ari.removeListener(AriEvent.PLAYBACK_FINISHED, listener);
				resolve();
			}
		};

		ari.on(AriEvent.PLAYBACK_FINISHED, listener);
	});
};

export { awaitForPlaybackFinished };
