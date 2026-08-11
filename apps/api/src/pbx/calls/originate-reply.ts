import { originateResponseSchema } from "@optimiq-voice/events/schemas";
import { originateRefusalException, originateUnavailableException } from "./calls.errors";

/**
 * Turning the engine's reply into either a call or an HTTP failure.
 *
 * Split out of `CallsService` so the mapping is testable without a broker: every branch here is a
 * shape of reply, and the assertion worth making is that each one produces the status a client can
 * act on. The service owns the connection and the rate limit; this owns the interpretation.
 */

export interface AcceptedOriginate {
	readonly callId: string;
	readonly legId: string;
	readonly instanceId?: string;
}

/**
 * @throws the mapped refusal, or a 503 when the reply is not something this API can act on
 */
export function interpretOriginateReply(
	raw: Uint8Array,
	context: { readonly from: string; readonly to: string },
): AcceptedOriginate {
	let response: ReturnType<typeof originateResponseSchema.parse>;
	try {
		response = originateResponseSchema.parse(JSON.parse(new TextDecoder().decode(raw)));
	} catch {
		// A reply that is not the contract. A 503 rather than a 500, and rather than a caller error:
		// the caller had no part in producing it, and an engine that answers gibberish is a broken
		// deployment rather than a broken request.
		throw originateUnavailableException("the call engine replied with something unreadable");
	}

	if (!response.ok) {
		throw originateRefusalException(response.reason ?? "internal", response.error, {
			from: context.from,
			to: context.to,
			...(response.instanceId === undefined ? {} : { instanceId: response.instanceId }),
		});
	}

	if (response.callId === undefined || response.legId === undefined) {
		// `ok` with no ids is a responder bug. Refused rather than returned, because the ids are the
		// only thing this response is FOR — without them the caller can correlate nothing, and a 201
		// carrying nulls would be a success the integrator cannot use.
		throw originateUnavailableException("the call engine reported success with no call id");
	}

	return {
		callId: response.callId,
		legId: response.legId,
		...(response.instanceId === undefined ? {} : { instanceId: response.instanceId }),
	};
}
