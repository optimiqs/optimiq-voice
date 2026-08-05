import { z } from "zod";
import * as SDK from "@optimiq-voice/sdk";
import { ListNumbersSchema } from "../schemas";

/**
 * Lists numbers from Optimiq Voice
 * @param client The Optimiq Voice client
 * @returns A function that lists numbers
 */
export function createListNumbers(client: SDK.Client) {
	return async function listNumbers(params: z.infer<typeof ListNumbersSchema>) {
		const numbers = new SDK.Numbers(client);

		const response = await numbers.listNumbers({
			pageSize: params.page_size,
			pageToken: params.page_token,
		});

		return {
			content: response.items.map((app) => ({
				type: "text" as const,
				text: JSON.stringify({
					ref: app.ref,
					name: app.name,
					telUrl: app.telUrl,
				}),
			})),
		};
	};
}
