import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BadRequestException, Controller, Get, Param, StreamableFile } from "@nestjs/common";
import { PublicRoute } from "../auth/public-route.decorator";

const RECORDINGS_DIRECTORY = "/opt/optimiq-voice/recordings";

@Controller("api/recordings")
export class RecordingsController {
	/**
	 * Deliberately anonymous, and NOT because it is safe.
	 *
	 * `apps/autopilot` builds `${AUTOPILOT_RECORDING_BASE_URL}/<appRef>_<mediaSessionRef>.wav`
	 * (`src/handleVoiceRequest.ts:134`) and posts it to a customer's `eventsHook` webhook, so the
	 * fetcher is an arbitrary third party with no session. Putting the global guard in front of it
	 * would break every conversation-ended webhook.
	 *
	 * The route is therefore an unauthenticated read of any recording whose file name is guessed —
	 * `resolve()` plus the `dirname` check stops path traversal but nothing stops enumeration. The
	 * correct fix is a signed, expiring URL minted alongside the recording; that is a Phase 2
	 * media-pipeline change, not part of the identity cutover, and is recorded as a follow-up in
	 * `plans/identity-removal.md`.
	 */
	@Get(":id")
	@PublicRoute()
	async getRecording(@Param("id") id: string) {
		const recordingPath = resolve(RECORDINGS_DIRECTORY, id);
		if (dirname(recordingPath) !== RECORDINGS_DIRECTORY) {
			throw new BadRequestException("Invalid recording ID");
		}

		const recording = await readFile(recordingPath);
		return new StreamableFile(recording, { type: "audio/wav" });
	}
}
