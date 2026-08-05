import SDK from "@routr/sdk";
import { ClientOptions } from "../types";
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent
} from "./operations";

function buildService(clientOptions: ClientOptions) {
  const client = new SDK.Agents(clientOptions);

  return {
    definition: {
      serviceName: "Agents",
      pckg: "agents",
      version: "v1beta2",
      proto: "agents.proto"
    },
    handlers: {
      createAgent: createAgent(client),
      updateAgent: updateAgent(client),
      getAgent: getAgent(client),
      listAgents: listAgents(client),
      deleteAgent: deleteAgent(client)
    }
  };
}

export { buildService };
