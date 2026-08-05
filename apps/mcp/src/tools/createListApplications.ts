import { z } from "zod";
import * as SDK from "@optimiq-voice/sdk";
import { ListApplicationsSchema } from "../schemas";

/**
 * Lists applications from Optimiq Voice
 * @param client The Optimiq Voice client
 * @returns A function that lists applications
 */
export function createListApplications(client: SDK.Client) {
	return async function listApplications(params: z.infer<typeof ListApplicationsSchema>) {
		const apps = new SDK.Applications(client);

		const response = await apps.listApplications({
			pageSize: params.page_size,
			pageToken: params.page_token,
		});

		return {
			content: response.items.map((app) => ({
				type: "text" as const,
				text: JSON.stringify({
					ref: app.ref,
					name: app.name,
					endpoint: app.endpoint,
					createdAt: app.createdAt,
					updatedAt: app.updatedAt,
					type: app.type,
				}),
			})),
		};
	};
}
