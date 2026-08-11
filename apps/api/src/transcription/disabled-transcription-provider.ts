import { TranscriptionFailure } from "./transcription-provider";
import type {
	TranscriptionAudio,
	TranscriptionDriver,
	TranscriptionProvider,
	TranscriptionResult,
} from "./transcription-provider";

/**
 * The default provider: transcription is off.
 *
 * ## Zero external calls, and zero internal ones
 *
 * `enabled` is false, and every caller gates on it before building a request — which means on a
 * default deployment nothing opens an object, nothing allocates a buffer, and no queue entry is
 * made. The alternative shape, a provider whose `transcribe` quietly returns an empty result, would
 * cost an object read and a heap allocation per voicemail to produce a column that stays null. That
 * is the difference between a feature being OFF and a feature being on and useless.
 *
 * ## Why `transcribe` throws rather than returning nothing
 *
 * A no-op return would make a caller that forgot the `enabled` check appear to work: every message
 * would be marked `done` with an empty transcript, which is indistinguishable in the database from
 * a real transcription of silence. The throw makes that bug loud in a test run rather than silent
 * in six months of rows.
 *
 * It is a {@link TranscriptionFailure} with `retryable: false` rather than a bare `Error` so that
 * even if it does escape into the pipeline, the pipeline marks the row `failed` once and moves on
 * instead of retrying a provider that is never going to answer.
 */
export class DisabledTranscriptionProvider implements TranscriptionProvider {
	readonly driver: TranscriptionDriver = "disabled";
	readonly enabled = false;

	async transcribe(audio: TranscriptionAudio): Promise<TranscriptionResult> {
		throw new TranscriptionFailure(
			`transcription is disabled but was asked to transcribe ${audio.objectKey}; ` +
				"callers must check `enabled` before building a request",
			{ retryable: false },
		);
	}
}
