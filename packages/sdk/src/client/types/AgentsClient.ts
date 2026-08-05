import {
	Agent,
	CreateAgentRequest,
	CreateAgentResponse,
	DeleteAgentRequest,
	DeleteAgentResponse,
	GetAgentRequest,
	ListAgentsRequest,
	ListAgentsResponse,
	UpdateAgentRequest,
	UpdateAgentResponse,
} from "../../generated/web/agents_pb";
import { ClientFunction } from "./common";

type AgentsClient = {
	createAgent: ClientFunction<CreateAgentRequest, CreateAgentResponse>;
	getAgent: ClientFunction<GetAgentRequest, Agent>;
	updateAgent: ClientFunction<UpdateAgentRequest, UpdateAgentResponse>;
	listAgents: ClientFunction<ListAgentsRequest, ListAgentsResponse>;
	deleteAgent: ClientFunction<DeleteAgentRequest, DeleteAgentResponse>;
};

export { AgentsClient };
