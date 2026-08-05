import { VoiceRequest } from "@optimiq-voice/common";

type ServerConfig = {
	bind?: string;
	port?: number;
};

type CheckMethodAuthorizedRequest = {
	accessKeyId: string;
	method: string;
};

type AddBillingMeterEventRequest = {
	accessKeyId: string;
	payload: Record<string, unknown>;
};

type AuthzHandler = {
	checkSessionAuthorized(request: VoiceRequest): Promise<boolean>;
	checkMethodAuthorized(request: CheckMethodAuthorizedRequest): Promise<boolean>;
	addBillingMeterEvent(request: AddBillingMeterEventRequest): Promise<void>;
};

export {
	ServerConfig,
	AuthzHandler,
	VoiceRequest,
	CheckMethodAuthorizedRequest,
	AddBillingMeterEventRequest,
};
