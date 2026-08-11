/**
 * The transcription seam.
 *
 * `src/transcription` rather than a slice of the PBX area, for the reason `src/storage` and
 * `src/mail` sit where they do: speech-to-text is a platform capability with an environment
 * contract of its own, and the next thing that wants one — a back-fill over the messages filed
 * while a provider was down, a call-recording summary, a future `apps/mediad` — must not have to
 * import `src/pbx/voicemail-boxes` to find it.
 *
 * Read `transcription-provider.ts` first: it carries the port AND the rule that shapes both drivers
 * (a provider is never handed an object store, only a closure already bound to one message's audio).
 */

export { DisabledTranscriptionProvider } from "./disabled-transcription-provider";
export {
	isRetryableStatus,
	OpenAiTranscriptionProvider,
	parseTranscriptionBody,
} from "./openai-transcription-provider";
export type { TranscriptionFetch } from "./openai-transcription-provider";
export {
	assertTranscriptionPreflight,
	isTranscriptionConfigured,
	loadTranscriptionEnv,
	selectTranscriptionDriver,
	TRANSCRIPTION_DRIVERS,
	transcriptionEnvSchema,
} from "./transcription-env";
export type { TranscriptionEnv } from "./transcription-env";
export {
	createTranscriptionProvider,
	describeTranscriptionProvider,
} from "./transcription-provider.factory";
export { readAudioWithLimit, TranscriptionFailure } from "./transcription-provider";
export type {
	TranscriptionAudio,
	TranscriptionDriver,
	TranscriptionProvider,
	TranscriptionResult,
} from "./transcription-provider";
