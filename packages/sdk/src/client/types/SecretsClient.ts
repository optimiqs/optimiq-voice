import {
	CreateSecretRequest,
	CreateSecretResponse,
	DeleteSecretRequest,
	DeleteSecretResponse,
	GetSecretRequest,
	ListSecretsRequest,
	ListSecretsResponse,
	Secret,
	UpdateSecretRequest,
	UpdateSecretResponse,
} from "../../generated/web/secrets_pb";
import { ClientFunction } from "./common";

type SecretsClient = {
	createSecret: ClientFunction<CreateSecretRequest, CreateSecretResponse>;
	getSecret: ClientFunction<GetSecretRequest, Secret>;
	updateSecret: ClientFunction<UpdateSecretRequest, UpdateSecretResponse>;
	listSecrets: ClientFunction<ListSecretsRequest, ListSecretsResponse>;
	deleteSecret: ClientFunction<DeleteSecretRequest, DeleteSecretResponse>;
};

export { SecretsClient };
