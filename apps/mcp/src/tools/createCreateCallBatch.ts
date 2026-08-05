import { z } from "zod";
import * as SDK from "@optimiq-voice/sdk";
import { CreateCallBatchSchema } from "../schemas";

/**
 * Creates multiple calls from Optimiq Voice in a batch with the same from number and application
 * @param client The Optimiq Voice client
 * @returns A function that creates multiple calls in a batch
 */
export function createCreateCallBatch(client: SDK.Client) {
	return async function createCallBatch(params: z.infer<typeof CreateCallBatchSchema>) {
		const calls = new SDK.Calls(client);

		const validatedParams = CreateCallBatchSchema.parse(params);
		const { from, to_array, app_ref, timeout, metadata, calls_per_minute } = validatedParams;
		const batchId = Date.now().toString();

		const createSingleCall = (to: string) =>
			calls.createCall({
				from,
				to,
				appRef: app_ref,
				timeout,
				metadata,
			});

		const delayBetweenCalls = Math.ceil(60000 / calls_per_minute);
		const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

		(async () => {
			const destinations = [...to_array];

			while (destinations.length > 0) {
				const to = destinations.shift();

				createSingleCall(to).catch((error) => {
					console.error(`Failed to create call to ${to}: ${error.message}`);
				});

				if (destinations.length > 0) {
					await delay(delayBetweenCalls);
				}
			}
		})();

		return {
			content: [
				{
					type: "text" as const,
					text:
						`Batch of ${to_array.length} calls from ${from} initiated with ID: ${batchId}. ` +
						`Calls are being processed asynchronously at a rate of ${calls_per_minute} calls per minute.`,
				},
			],
		};
	};
}
