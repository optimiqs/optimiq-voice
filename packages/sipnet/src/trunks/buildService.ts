import SDK from "@routr/sdk";
import { ClientOptions } from "../types";
import {
  createTrunk,
  deleteTrunk,
  getTrunk,
  listTrunks,
  updateTrunk
} from "./operations";

function buildService(clientOptions: ClientOptions) {
  const client = new SDK.Trunks(clientOptions);

  return {
    definition: {
      serviceName: "Trunks",
      pckg: "trunks",
      version: "v1beta2",
      proto: "trunks.proto"
    },
    handlers: {
      createTrunk: createTrunk(client),
      updateTrunk: updateTrunk(client),
      getTrunk: getTrunk(client),
      listTrunks: listTrunks(client),
      deleteTrunk: deleteTrunk(client)
    }
  };
}

export { buildService };
