import { AbstractSpeechToText } from "../stt/AbstractSpeechToText";
import { AbstractTextToSpeech } from "../tts/AbstractTextToSpeech";

type IntegrationsContainer = {
	ref: string;
	/**
	 * The owning tenant, read straight from `applications.organization_id` since Step 5 item 1.
	 * It used to be the legacy `WO…` access key, which `createCreateVoiceClient` then had to
	 * translate through the Step 2 ledger on every call.
	 */
	organizationId: string;
	endpoint: string;
	tts: AbstractTextToSpeech<unknown>;
	stt: AbstractSpeechToText<unknown>;
};

type CreateContainer = (appRef: string) => Promise<IntegrationsContainer>;

export { type CreateContainer, type IntegrationsContainer };
