import { Empty } from "google-protobuf/google/protobuf/empty_pb";
import {
	Application,
	CreateApplicationRequest,
	CreateApplicationResponse,
	DeleteApplicationRequest,
	DeleteApplicationResponse,
	EvaluateIntelligenceEvent,
	EvaluateIntelligenceRequest,
	GetApplicationRequest,
	ListApplicationsRequest,
	ListApplicationsResponse,
	TestTokenResponse,
	UpdateApplicationRequest,
	UpdateApplicationResponse,
} from "../../generated/web/applications_pb";
import { ClientFunction } from "./common";
import type { ClientReadableStream } from "grpc-web";

type ApplicationsClient = {
	createApplication: ClientFunction<CreateApplicationRequest, CreateApplicationResponse>;
	getApplication: ClientFunction<GetApplicationRequest, Application>;
	updateApplication: ClientFunction<UpdateApplicationRequest, UpdateApplicationResponse>;
	listApplications: ClientFunction<ListApplicationsRequest, ListApplicationsResponse>;
	deleteApplication: ClientFunction<DeleteApplicationRequest, DeleteApplicationResponse>;
	evaluateIntelligence: (
		request: EvaluateIntelligenceRequest,
		metadata?: Record<string, string> | null,
	) => ClientReadableStream<EvaluateIntelligenceEvent>;
	createTestToken: ClientFunction<Empty, TestTokenResponse>;
};

export { ApplicationsClient };
