import SDK from "@routr/sdk";
import { ClientOptions } from "../types";
import { createAcl } from "./createAcl";
import { deleteAcl, getAcl, listAcls } from "./operations";
import { updateAcl } from "./updateAcl";

function buildService(clientOptions: ClientOptions) {
  const client = new SDK.Acls(clientOptions);

  return {
    definition: {
      serviceName: "Acls",
      pckg: "acls",
      version: "v1beta2",
      proto: "acls.proto"
    },
    handlers: {
      createAcl: createAcl(client),
      updateAcl: updateAcl(client),
      getAcl: getAcl(client),
      listAcls: listAcls(client),
      deleteAcl: deleteAcl(client)
    }
  };
}

export { buildService };
