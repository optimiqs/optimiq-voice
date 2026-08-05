import { Validators as V } from "@optimiq-voice/common";
import {
	AgentExtended,
	AgentsApi,
	BaseApiObject,
	CreateAgentRequestExtended,
	ListAgentsRequest,
	UpdateAgentRequest,
} from "@optimiq-voice/types";
import { createResource } from "../resources/createResource";
import { deleteResource } from "../resources/deleteResource";
import { getResource } from "../resources/getResource";
import { listResources } from "../resources/listResources";
import { updateResource } from "../resources/updateResource";

const RESOURCE = "Agent";

function createAgent(agents: AgentsApi) {
	return createResource<AgentExtended, CreateAgentRequestExtended, AgentsApi>(
		agents,
		RESOURCE,
		V.createAgentRequestSchema,
	);
}

function updateAgent(agents: AgentsApi) {
	return updateResource<AgentExtended, UpdateAgentRequest, AgentsApi>(
		agents,
		RESOURCE,
		V.updateAgentRequestSchema,
	);
}

function getAgent(agents: AgentsApi) {
	return getResource<AgentExtended, BaseApiObject, AgentsApi>(agents, RESOURCE);
}

function listAgents(agents: AgentsApi) {
	return listResources<AgentExtended, ListAgentsRequest, AgentsApi>(agents, RESOURCE);
}

function deleteAgent(agents: AgentsApi) {
	return deleteResource<AgentExtended, BaseApiObject, AgentsApi>(agents, RESOURCE);
}

export { createAgent, deleteAgent, getAgent, listAgents, updateAgent };
