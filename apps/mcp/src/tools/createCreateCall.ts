import { z } from "zod";
import * as SDK from "@optimiq-voice/sdk";
import { CreateCallSchema } from "../schemas";

/**
 * Creates a call from Optimiq Voice
 * @param client The Optimiq Voice client
 * @returns A function that creates a call
 */
export function createCreateCall(client: SDK.Client) {
	return async function createCall(params: z.infer<typeof CreateCallSchema>) {
		const calls = new SDK.Calls(client);
		const call = await calls.createCall({
			from: params.from,
			to: params.to,
			appRef: params.app_ref,
			timeout: params.timeout,
			metadata: params.metadata,
		});

		return {
			content: [{ type: "text" as const, text: `Call created with REF: ${call.ref}` }],
		};
	};
}
