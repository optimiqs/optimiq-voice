import { BaseApiObject, ListRequest, ListResponse } from "./common";
import { Flatten, RenameAndConvertToTimestamp } from "./utils";

type Credentials = {
	ref: string;
	name: string;
	username: string;
	createdAt: Date;
	updatedAt: Date;
};

type CredentialsExtended = RenameAndConvertToTimestamp<Credentials> & {
	extended?: Record<string, unknown>;
};

type CreateCredentialsRequest = {
	name: string;
	username: string;
	password: string;
};

type CreateCredentialsRequestExtended = CreateCredentialsRequest & {
	extended?: Record<string, unknown>;
};

type UpdateCredentialsRequest = Flatten<BaseApiObject & { name: string }>;

type ListCredentialsRequest = ListRequest;

type ListCredentialsResponse = ListResponse<Credentials>;

type ListCredentialsResponseExtended = ListResponse<CredentialsExtended>;

type CredentialsApi = {
	createCredentials(request: CreateCredentialsRequestExtended): Promise<BaseApiObject>;
	updateCredentials(request: UpdateCredentialsRequest): Promise<BaseApiObject>;
	getCredentials(ref: string): Promise<CredentialsExtended>;
	deleteCredentials(ref: string): Promise<void>;
	listCredentials(request: ListCredentialsRequest): Promise<ListCredentialsResponseExtended>;
};

export {
	CreateCredentialsRequest,
	CreateCredentialsRequestExtended,
	Credentials,
	CredentialsApi,
	CredentialsExtended,
	ListCredentialsRequest,
	ListCredentialsResponse,
	UpdateCredentialsRequest,
};
