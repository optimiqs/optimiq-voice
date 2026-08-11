import { DisabledTranscriptionProvider } from "./disabled-transcription-provider";
import { OpenAiTranscriptionProvider } from "./openai-transcription-provider";
import { selectTranscriptionDriver } from "./transcription-env";
import type { TranscriptionFetch } from "./openai-transcription-provider";
import type { TranscriptionEnv } from "./transcription-env";
import type { TranscriptionProvider } from "./transcription-provider";

/**
 * Builds the provider an environment asks for.
 *
 * One function rather than a `switch` at each call site, on the same terms as `createObjectStore`:
 * the mapping from configuration to driver is a decision, it is made once, and a caller injects the
 * result. Nothing outside this file constructs a driver in production code.
 *
 * The `fetch` seam is a parameter with a default rather than a constructor argument threaded from
 * the module, because the only caller that overrides it is a test. Defaulting to `globalThis.fetch`
 * keeps the production wiring a one-liner; passing it keeps the tests off the network. `bind` is
 * required — an unbound `fetch` throws `Illegal invocation` in some runtimes.
 */
export function createTranscriptionProvider(
	env: TranscriptionEnv,
	fetchImpl: TranscriptionFetch = globalThis.fetch.bind(
		globalThis,
	) as unknown as TranscriptionFetch,
): TranscriptionProvider {
	if (selectTranscriptionDriver(env) === "disabled") {
		return new DisabledTranscriptionProvider();
	}
	return new OpenAiTranscriptionProvider(env, fetchImpl);
}

/**
 * A line for the boot log: what an operator needs in order to recognise their own configuration.
 *
 * The API key is never named, not even by length. The BASE URL is, because a base URL missing its
 * `/v1` is the single most common way this is misconfigured and it is the one fact that makes that
 * visible without reaching for the environment.
 */
export function describeTranscriptionProvider(
	provider: TranscriptionProvider,
	env: TranscriptionEnv,
): string {
	if (!provider.enabled) {
		return "voicemail transcription is disabled (TRANSCRIBE_BASE_URL is not set)";
	}
	const auth = env.apiKey === undefined ? "no api key" : "api key set";
	return (
		`voicemail transcription via ${env.baseUrl}/audio/transcriptions ` +
		`(model ${env.model}, ${auth})`
	);
}
