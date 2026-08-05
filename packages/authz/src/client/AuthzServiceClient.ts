import * as grpc from "@grpc/grpc-js";
import { AddBillingMeterEventRequest, CheckMethodAuthorizedRequest, VoiceRequest } from "../types";

/**
 * Interface representing the AuthzService client methods.
 * This should match the service definition used by the server.
 */
interface AuthzServiceClient extends grpc.Client {
	checkSessionAuthorized(
		request: Partial<VoiceRequest>,
		callback: grpc.requestCallback<{ authorized: boolean }>,
	): void;

	checkMethodAuthorized(
		request: CheckMethodAuthorizedRequest,
		callback: grpc.requestCallback<{ authorized: boolean }>,
	): void;

	addBillingMeterEvent(
		request: AddBillingMeterEventRequest,
		callback: grpc.requestCallback<object>,
	): void;
}

export { AuthzServiceClient };
