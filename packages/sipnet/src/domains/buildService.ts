import SDK from "@routr/sdk";
import { ClientOptions } from "../types";
import {
  createDomain,
  deleteDomain,
  getDomain,
  listDomains,
  updateDomain
} from "./operations";

function buildService(clientOptions: ClientOptions) {
  const client = new SDK.Domains(clientOptions);

  return {
    definition: {
      serviceName: "Domains",
      pckg: "domains",
      version: "v1beta2",
      proto: "domains.proto"
    },
    handlers: {
      createDomain: createDomain(client),
      updateDomain: updateDomain(client),
      getDomain: getDomain(client),
      listDomains: listDomains(client),
      deleteDomain: deleteDomain(client)
    }
  };
}

export { buildService };
