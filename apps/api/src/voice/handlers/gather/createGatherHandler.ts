import { z } from "zod";
import {
	GatherRequest,
	GatherSource,
	MUST_BE_A_SINGLE_CHARACTER,
	POSITIVE_INTEGER_MESSAGE,
} from "@optimiq-voice/common";
import { VoiceClient } from "../../types";
import { isDtmf } from "../utils";
import { withErrorHandling } from "../utils/withErrorHandling";
import { getTimeoutPromise } from "./getTimeoutPromise";

const gatherRequestSchema = z.object({
	source: z.optional(z.nativeEnum(GatherSource, { message: "Invalid gather source" })).optional(),
	maxDigits: z
		.number()
		.int({
			message: POSITIVE_INTEGER_MESSAGE,
		})
		.positive({
			message: POSITIVE_INTEGER_MESSAGE,
		})
		.optional(),
	finishOnKey: z
		.string()
		.regex(/^[0-9*#]$/)
		.max(1, { message: MUST_BE_A_SINGLE_CHARACTER })
		.optional(),
});

function createGatherHandler(voiceClient: VoiceClient) {
	return withErrorHandling(async (request: GatherRequest) => {
		const { mediaSessionRef, source, timeout, finishOnKey, maxDigits } = request;

		gatherRequestSchema.parse(request);

		const { timeoutPromise, effectiveTimeout } = getTimeoutPromise(timeout);

		const effectiveSource = source || GatherSource.SPEECH_AND_DTMF;

		const promises = [timeoutPromise];

		if (effectiveSource.includes(GatherSource.SPEECH)) {
			promises.push(voiceClient.transcribe().then((result) => result));
		}

		if (effectiveSource.includes(GatherSource.DTMF)) {
			promises.push(
				voiceClient
					.waitForDtmf({
						mediaSessionRef,
						finishOnKey,
						maxDigits,
						timeout: effectiveTimeout,
						onDigitReceived: timeoutPromise.cancelGlobalTimer,
					})
					.then((result) => result),
			);
		}

		const result = (await Promise.race(promises)) as {
			responseTime: number;
			speech?: string;
			digits?: string;
		};

		voiceClient.sendResponse({
			gatherResponse: {
				mediaSessionRef,
				responseTime: result.responseTime,
				speech: isDtmf(result.digits) ? undefined : result.speech,
				digits: isDtmf(result.digits) ? result.digits : undefined,
			},
		});
	});
}

export { createGatherHandler };
