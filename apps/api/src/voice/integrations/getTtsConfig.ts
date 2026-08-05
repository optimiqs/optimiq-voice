import {
  findIntegrationsCredentials,
  IntegrationConfig
} from "@optimiq-voice/common";
import { Application } from "@optimiq-voice/types";

function getTtsConfig(integrations: IntegrationConfig[], app: Application) {
  const config = app.textToSpeech.config;
  const credentials = findIntegrationsCredentials(
    integrations,
    app.textToSpeech.productRef
  );

  return {
    config,
    credentials
  };
}

export { getTtsConfig };
