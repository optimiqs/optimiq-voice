import { BaseApiObject, ListRequest, ListResponse } from "./common";

type Secret = {
  ref: string;
  name: string;
  secret: string;
  createdAt: number;
  updatedAt: number;
};

type CreateSecretRequest = {
  name: string;
  secret: string;
};

type UpdateSecretRequest = BaseApiObject & Partial<CreateSecretRequest>;

type ListSecretsRequest = ListRequest;

type ListSecretsResponse = ListResponse<Secret>;

export {
  CreateSecretRequest,
  ListSecretsRequest,
  ListSecretsResponse,
  Secret,
  UpdateSecretRequest
};
