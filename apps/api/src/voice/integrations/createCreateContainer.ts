import {
	AUTOPILOT_INTERNAL_ADDRESS,
	AUTOPILOT_SPECIAL_LOCAL_ADDRESS,
	WELCOME_DEMO_SPECIAL_LOCAL_ADDRESS,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { Application } from "@optimiq-voice/types";
import { Database } from "../../core/db";
import { API_HOST } from "../../envs";
import { getIntegrationsFromFile } from "../../utils/getIntegrationsFromFile";
import { SpeechToTextFactory } from "../stt/SpeechToTextFactory";
import { TextToSpeechFactory } from "../tts/TextToSpeechFactory";
import { ApplicationNotFoundError } from "./ApplicationNotFoundError";
import { getSttConfig } from "./getSttConfig";
import { getTtsConfig } from "./getTtsConfig";
import { IntegrationsContainer } from "./types";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function createCreateContainer(db: Database, pathToIntegrations: string) {
	logger.verbose("loading integrations config", { pathToIntegrations });

	const integrations = getIntegrationsFromFile(pathToIntegrations);

	return async function createContainer(appRef: string): Promise<IntegrationsContainer> {
		logger.verbose("creating integrations container", { appRef });

		const app = await db.application.findUnique({
			where: { ref: appRef },
			include: {
				textToSpeech: true,
				speechToText: true,
				intelligence: true,
			},
		});

		if (!app) {
			throw new ApplicationNotFoundError(appRef);
		}

		const ttsConfig = getTtsConfig(integrations, app as Application);
		const sttConfig = getSttConfig(integrations, app as Application);

		const tts = TextToSpeechFactory.getEngine(app.textToSpeech.productRef, ttsConfig);

		const stt = SpeechToTextFactory.getEngine(app.speechToText.productRef, sttConfig);

		const actualEndpoint =
			app.endpoint === AUTOPILOT_SPECIAL_LOCAL_ADDRESS
				? AUTOPILOT_INTERNAL_ADDRESS
				: app.endpoint === WELCOME_DEMO_SPECIAL_LOCAL_ADDRESS
					? `${API_HOST}:50051`
					: app.endpoint;

		return {
			ref: appRef,
			accessKeyId: app.accessKeyId,
			endpoint: actualEndpoint,
			tts,
			stt,
		};
	};
}

export { createCreateContainer };
