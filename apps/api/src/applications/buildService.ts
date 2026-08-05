import { createEvaluateIntelligence } from "@optimiq-voice/autopilot";
import { Database } from "../core/db";
import { INTEGRATIONS_FILE } from "../envs";
import { getIntegrationsFromFile } from "../utils/getIntegrationsFromFile";
import { createCreateApplication } from "./createCreateApplication";
import { createCreateTestToken } from "./createCreateTestToken";
import { createDeleteApplication } from "./createDeleteApplication";
import { createGetApplication } from "./createGetApplication";
import { createListApplications } from "./createListApplications";
import { createUpdateApplication } from "./createUpdateApplication";
import { TestTokenConfiguration } from "./types";

function buildService(db: Database, testTokenConfig: TestTokenConfiguration) {
  const integrations = getIntegrationsFromFile(INTEGRATIONS_FILE);

  return {
    definition: {
      serviceName: "Applications",
      pckg: "applications",
      version: "v1beta2",
      proto: "applications.proto"
    },
    handlers: {
      createApplication: createCreateApplication(db),
      getApplication: createGetApplication(db),
      listApplications: createListApplications(db),
      deleteApplication: createDeleteApplication(db),
      updateApplication: createUpdateApplication(db),
      evaluateIntelligence: createEvaluateIntelligence(integrations),
      createTestToken: createCreateTestToken(testTokenConfig)
    }
  };
}

export { buildService };
