import { join } from "path";
import dotenv from "dotenv";
import { assertEnvsAreSet, assertFileExists } from "@optimiq-voice/common";
import logger from "@optimiq-voice/logger";
import { ConversationProvider } from "./types";

if (process.env.NODE_ENV === "development") {
	dotenv.config({ path: join(__dirname, "..", "..", "..", ".env") });
}

const e = process.env;

export const AWS_S3_ACCESS_KEY_ID = e.AUTOPILOT_AWS_S3_ACCESS_KEY_ID ?? "";
export const AWS_S3_ENDPOINT = e.AUTOPILOT_AWS_S3_ENDPOINT || undefined;
export const AWS_S3_REGION = e.AUTOPILOT_AWS_S3_REGION ?? "us-east-1";
export const AWS_S3_SECRET_ACCESS_KEY = e.AUTOPILOT_AWS_S3_SECRET_ACCESS_KEY ?? "";
export const KNOWLEDGE_BASE_ENABLED = e.AUTOPILOT_KNOWLEDGE_BASE_ENABLED === "true";
export const NODE_ENV = e.NODE_ENV || "production";
export const UNSTRUCTURED_API_KEY = e.AUTOPILOT_UNSTRUCTURED_API_KEY ?? "";
export const UNSTRUCTURED_API_URL =
	e.AUTOPILOT_UNSTRUCTURED_API_URL ?? "https://api.unstructuredapp.io/general/v0/general";
export const CONVERSATION_PROVIDER = e.AUTOPILOT_CONVERSATION_PROVIDER
	? e.AUTOPILOT_CONVERSATION_PROVIDER
	: ConversationProvider.FILE;
export const CONVERSATION_PROVIDER_FILE = e.AUTOPILOT_CONVERSATION_PROVIDER_FILE
	? e.AUTOPILOT_CONVERSATION_PROVIDER_FILE
	: `${process.cwd()}/config/assistant.json`;
export const API_ENDPOINT = e.AUTOPILOT_API_ENDPOINT ? e.AUTOPILOT_API_ENDPOINT : "api:50051";
export const INTEGRATIONS_FILE = e.AUTOPILOT_INTEGRATIONS_FILE
	? e.AUTOPILOT_INTEGRATIONS_FILE
	: "/opt/optimiq-voice/integrations.json";
export const OPENAI_API_KEY = e.AUTOPILOT_OPENAI_API_KEY;
export const SKIP_IDENTITY = e.AUTOPILOT_SKIP_IDENTITY === "true";
export const RECORDING_BASE_URL = e.AUTOPILOT_RECORDING_BASE_URL
	? e.AUTOPILOT_RECORDING_BASE_URL
	: "http://localhost:9876/api/recordings";

if (
	CONVERSATION_PROVIDER!.toLocaleLowerCase() !== ConversationProvider.API &&
	CONVERSATION_PROVIDER!.toLocaleLowerCase() !== ConversationProvider.FILE
) {
	console.error("CONVERSATION_PROVIDER must be set to 'api' or 'file'");
	process.exit(1);
}

if (CONVERSATION_PROVIDER!.toLocaleLowerCase() === ConversationProvider.API) {
	assertFileExists(INTEGRATIONS_FILE);
}

if (KNOWLEDGE_BASE_ENABLED) {
	assertEnvsAreSet([
		"AUTOPILOT_AWS_S3_ACCESS_KEY_ID",
		"AUTOPILOT_AWS_S3_SECRET_ACCESS_KEY",
		"AUTOPILOT_UNSTRUCTURED_API_KEY",
	]);

	if (!AWS_S3_ENDPOINT && !AWS_S3_REGION) {
		logger.error(
			"Knowledge base configuration error: Either AUTOPILOT_AWS_S3_ENDPOINT or AUTOPILOT_AWS_S3_REGION must be set when using AWS S3",
		);
		process.exit(1);
	}
}
