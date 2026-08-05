import { findIntegrationsCredentials, VoiceRequest } from "@optimiq-voice/common";
import { assistantSchema } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import * as SDK from "@optimiq-voice/sdk";
import { AssistantConfig } from "./assistants";
import { API_ENDPOINT } from "./envs";
import { AutopilotApplication } from "./types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

function loadAssistantFromAPI(
	req: VoiceRequest,
	// TODO: Add validation for integrations
	integrations: {
		productRef: string;
		credentials: Record<string, unknown>;
	}[],
): Promise<AssistantConfig> {
	return new Promise((resolve, reject) => {
		const clientConfig = {
			accessKeyId: req.accessKeyId,
			endpoint: API_ENDPOINT,
			allowInsecure: true,
			withoutInterceptors: true,
		};

		const client = new SDK.Client(clientConfig);
		client.setAccessToken(req.sessionToken);
		const applications = new SDK.Applications(client);

		logger.verbose(`loading assistant config from api`, {
			api: API_ENDPOINT,
			appRef: req.appRef,
		});

		applications
			.getApplication(req.appRef)
			.then((app: AutopilotApplication) => {
				logger.verbose(`get credentials for assistant`, {
					appRef: req.appRef,
					productRef: app.intelligence.productRef,
				});

				const credentials = findIntegrationsCredentials(integrations, app.intelligence.productRef);

				resolve(
					assistantSchema.parse({
						...app.intelligence.config,
						languageModel: {
							...app.intelligence.config.languageModel,
							apiKey: credentials.apiKey as string,
						},
					}),
				);
			})
			.catch((err) => {
				reject(new Error(`Failed to load assistant config from API: ${err}`));
			});
	});
}

export { loadAssistantFromAPI };
