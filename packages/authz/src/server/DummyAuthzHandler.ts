import { getLogger } from "@optimiq-voice/logger";
import {
	AddBillingMeterEventRequest,
	AuthzHandler,
	CheckMethodAuthorizedRequest,
	VoiceRequest,
} from "../types";
const logger = getLogger({ service: "authz", filePath: __filename });

class DummyAuthzHandler implements AuthzHandler {
	async checkSessionAuthorized(request: VoiceRequest): Promise<boolean> {
		logger.verbose("checkSessionAuthorized called", request);
		return true;
	}

	async checkMethodAuthorized(request: CheckMethodAuthorizedRequest): Promise<boolean> {
		logger.verbose("checkMethodAuthorized called", request);
		return true;
	}

	async addBillingMeterEvent(request: AddBillingMeterEventRequest): Promise<void> {
		logger.verbose("chargeAccount called", request);
	}
}

export { DummyAuthzHandler };
