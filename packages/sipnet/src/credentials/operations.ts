import { Validators as V } from "@optimiq-voice/common";
import {
  BaseApiObject,
  CreateCredentialsRequestExtended,
  CredentialsApi,
  CredentialsExtended,
  ListCredentialsRequest,
  UpdateCredentialsRequest
} from "@optimiq-voice/types";
import { createResource } from "../resources/createResource";
import { deleteResource } from "../resources/deleteResource";
import { getResource } from "../resources/getResource";
import { listResources } from "../resources/listResources";
import { updateResource } from "../resources/updateResource";

const RESOURCE = "Credentials";

function createCredentials(credentials: CredentialsApi) {
  return createResource<
    CredentialsExtended,
    CreateCredentialsRequestExtended,
    CredentialsApi
  >(credentials, RESOURCE, V.createCredentialsRequestSchema);
}

function updateCredentials(credentials: CredentialsApi) {
  return updateResource<
    CredentialsExtended,
    UpdateCredentialsRequest,
    CredentialsApi
  >(credentials, RESOURCE, V.updateCredentialsRequestSchema);
}

function getCredentials(credentials: CredentialsApi) {
  return getResource<CredentialsExtended, BaseApiObject, CredentialsApi>(
    credentials,
    RESOURCE
  );
}

function listCredentials(credentials: CredentialsApi) {
  return listResources<
    CredentialsExtended,
    ListCredentialsRequest,
    CredentialsApi
  >(credentials, RESOURCE);
}

function deleteCredentials(credentials: CredentialsApi) {
  return deleteResource<CredentialsExtended, BaseApiObject, CredentialsApi>(
    credentials,
    RESOURCE
  );
}

export {
  createCredentials,
  deleteCredentials,
  getCredentials,
  listCredentials,
  updateCredentials
};
