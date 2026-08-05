import {
	CreateCredentialsRequest,
	CreateCredentialsResponse,
	Credentials,
	DeleteCredentialsRequest,
	DeleteCredentialsResponse,
	GetCredentialsRequest,
	ListCredentialsRequest,
	ListCredentialsResponse,
	UpdateCredentialsRequest,
	UpdateCredentialsResponse,
} from "../../generated/web/credentials_pb";
import { ClientFunction } from "./common";

type CredentialsClient = {
	createCredentials: ClientFunction<CreateCredentialsRequest, CreateCredentialsResponse>;
	getCredentials: ClientFunction<GetCredentialsRequest, Credentials>;
	updateCredentials: ClientFunction<UpdateCredentialsRequest, UpdateCredentialsResponse>;
	listCredentials: ClientFunction<ListCredentialsRequest, ListCredentialsResponse>;
	deleteCredentials: ClientFunction<DeleteCredentialsRequest, DeleteCredentialsResponse>;
};

export { CredentialsClient };
