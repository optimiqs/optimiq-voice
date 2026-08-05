import fs from "fs";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "api", filePath: __filename });

const integrationsConfigSchema = z.array(
  z.object({
    name: z.string(),
    productRef: z.string(),
    type: z.enum(["tts", "stt", "llm"]),
    credentials: z.record(z.unknown())
  })
);

function getIntegrationsFromFile(pathToIntegrations: string) {
  const integrationsFile = fs.readFileSync(pathToIntegrations, "utf8");
  const integrations = JSON.parse(integrationsFile);
  try {
    integrationsConfigSchema.parse(integrations);
  } catch (e) {
    // fatal error
    const message = fromError(e, { prefix: null }).toString();
    logger.error("integrations config is invalid", { message });
    process.exit(1);
  }
  return integrations;
}

export { getIntegrationsFromFile };
