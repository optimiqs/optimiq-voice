import SDK from "@routr/sdk";
import { ClientOptions } from "../types";
import {
  createCredentials,
  deleteCredentials,
  getCredentials,
  listCredentials,
  updateCredentials
} from "./operations";

function buildService(clientOptions: ClientOptions) {
  const client = new SDK.Credentials(clientOptions);

  return {
    definition: {
      serviceName: "CredentialsService",
      pckg: "credentials",
      version: "v1beta2",
      proto: "credentials.proto"
    },
    handlers: {
      createCredentials: createCredentials(client),
      updateCredentials: updateCredentials(client),
      getCredentials: getCredentials(client),
      listCredentials: listCredentials(client),
      deleteCredentials: deleteCredentials(client)
    }
  };
}

export { buildService };
