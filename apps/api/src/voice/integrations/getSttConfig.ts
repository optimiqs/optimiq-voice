import {
	findIntegrationsCredentials,
	IntegrationConfig,
	VoiceLanguage,
} from "@optimiq-voice/common";
import { Application } from "@optimiq-voice/types";

function getSttConfig(integrations: IntegrationConfig[], app: Application) {
	const config = app.speechToText.config as { languageCode: VoiceLanguage };
	const credentials = findIntegrationsCredentials(integrations, app.speechToText.productRef);

	return {
		config,
		credentials,
	};
}

export { getSttConfig };
