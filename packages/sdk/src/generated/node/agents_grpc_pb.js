// GENERATED CODE -- DO NOT EDIT!

'use strict';
var grpc = require('@grpc/grpc-js');
var agents_pb = require('./agents_pb.js');

function serialize_optimiq_voice_agents_v1beta2_Agent(arg) {
  if (!(arg instanceof agents_pb.Agent)) {
    throw new Error('Expected argument of type optimiq_voice.agents.v1beta2.Agent');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_agents_v1beta2_Agent(buffer_arg) {
  return agents_pb.Agent.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_agents_v1beta2_CreateAgentRequest(arg) {
  if (!(arg instanceof agents_pb.CreateAgentRequest)) {
    throw new Error('Expected argument of type optimiq_voice.agents.v1beta2.CreateAgentRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_agents_v1beta2_CreateAgentRequest(buffer_arg) {
  return agents_pb.CreateAgentRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_agents_v1beta2_CreateAgentResponse(arg) {
  if (!(arg instanceof agents_pb.CreateAgentResponse)) {
    throw new Error('Expected argument of type optimiq_voice.agents.v1beta2.CreateAgentResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_agents_v1beta2_CreateAgentResponse(buffer_arg) {
  return agents_pb.CreateAgentResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_agents_v1beta2_DeleteAgentRequest(arg) {
  if (!(arg instanceof agents_pb.DeleteAgentRequest)) {
    throw new Error('Expected argument of type optimiq_voice.agents.v1beta2.DeleteAgentRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_agents_v1beta2_DeleteAgentRequest(buffer_arg) {
  return agents_pb.DeleteAgentRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_agents_v1beta2_DeleteAgentResponse(arg) {
  if (!(arg instanceof agents_pb.DeleteAgentResponse)) {
    throw new Error('Expected argument of type optimiq_voice.agents.v1beta2.DeleteAgentResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_agents_v1beta2_DeleteAgentResponse(buffer_arg) {
  return agents_pb.DeleteAgentResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_agents_v1beta2_GetAgentRequest(arg) {
  if (!(arg instanceof agents_pb.GetAgentRequest)) {
    throw new Error('Expected argument of type optimiq_voice.agents.v1beta2.GetAgentRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_agents_v1beta2_GetAgentRequest(buffer_arg) {
  return agents_pb.GetAgentRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_agents_v1beta2_ListAgentsRequest(arg) {
  if (!(arg instanceof agents_pb.ListAgentsRequest)) {
    throw new Error('Expected argument of type optimiq_voice.agents.v1beta2.ListAgentsRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_agents_v1beta2_ListAgentsRequest(buffer_arg) {
  return agents_pb.ListAgentsRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_agents_v1beta2_ListAgentsResponse(arg) {
  if (!(arg instanceof agents_pb.ListAgentsResponse)) {
    throw new Error('Expected argument of type optimiq_voice.agents.v1beta2.ListAgentsResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_agents_v1beta2_ListAgentsResponse(buffer_arg) {
  return agents_pb.ListAgentsResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_agents_v1beta2_UpdateAgentRequest(arg) {
  if (!(arg instanceof agents_pb.UpdateAgentRequest)) {
    throw new Error('Expected argument of type optimiq_voice.agents.v1beta2.UpdateAgentRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_agents_v1beta2_UpdateAgentRequest(buffer_arg) {
  return agents_pb.UpdateAgentRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_agents_v1beta2_UpdateAgentResponse(arg) {
  if (!(arg instanceof agents_pb.UpdateAgentResponse)) {
    throw new Error('Expected argument of type optimiq_voice.agents.v1beta2.UpdateAgentResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_agents_v1beta2_UpdateAgentResponse(buffer_arg) {
  return agents_pb.UpdateAgentResponse.deserializeBinary(new Uint8Array(buffer_arg));
}


// The Agents service definition
var AgentsService = exports.AgentsService = {
  // Create a new Agent
createAgent: {
    path: '/optimiq_voice.agents.v1beta2.Agents/CreateAgent',
    requestStream: false,
    responseStream: false,
    requestType: agents_pb.CreateAgentRequest,
    responseType: agents_pb.CreateAgentResponse,
    requestSerialize: serialize_optimiq_voice_agents_v1beta2_CreateAgentRequest,
    requestDeserialize: deserialize_optimiq_voice_agents_v1beta2_CreateAgentRequest,
    responseSerialize: serialize_optimiq_voice_agents_v1beta2_CreateAgentResponse,
    responseDeserialize: deserialize_optimiq_voice_agents_v1beta2_CreateAgentResponse,
  },
  // Update an existing Agent
updateAgent: {
    path: '/optimiq_voice.agents.v1beta2.Agents/UpdateAgent',
    requestStream: false,
    responseStream: false,
    requestType: agents_pb.UpdateAgentRequest,
    responseType: agents_pb.UpdateAgentResponse,
    requestSerialize: serialize_optimiq_voice_agents_v1beta2_UpdateAgentRequest,
    requestDeserialize: deserialize_optimiq_voice_agents_v1beta2_UpdateAgentRequest,
    responseSerialize: serialize_optimiq_voice_agents_v1beta2_UpdateAgentResponse,
    responseDeserialize: deserialize_optimiq_voice_agents_v1beta2_UpdateAgentResponse,
  },
  // Get an existing Agent
getAgent: {
    path: '/optimiq_voice.agents.v1beta2.Agents/GetAgent',
    requestStream: false,
    responseStream: false,
    requestType: agents_pb.GetAgentRequest,
    responseType: agents_pb.Agent,
    requestSerialize: serialize_optimiq_voice_agents_v1beta2_GetAgentRequest,
    requestDeserialize: deserialize_optimiq_voice_agents_v1beta2_GetAgentRequest,
    responseSerialize: serialize_optimiq_voice_agents_v1beta2_Agent,
    responseDeserialize: deserialize_optimiq_voice_agents_v1beta2_Agent,
  },
  // Delete an existing Agent
deleteAgent: {
    path: '/optimiq_voice.agents.v1beta2.Agents/DeleteAgent',
    requestStream: false,
    responseStream: false,
    requestType: agents_pb.DeleteAgentRequest,
    responseType: agents_pb.DeleteAgentResponse,
    requestSerialize: serialize_optimiq_voice_agents_v1beta2_DeleteAgentRequest,
    requestDeserialize: deserialize_optimiq_voice_agents_v1beta2_DeleteAgentRequest,
    responseSerialize: serialize_optimiq_voice_agents_v1beta2_DeleteAgentResponse,
    responseDeserialize: deserialize_optimiq_voice_agents_v1beta2_DeleteAgentResponse,
  },
  // List all Agents
listAgents: {
    path: '/optimiq_voice.agents.v1beta2.Agents/ListAgents',
    requestStream: false,
    responseStream: false,
    requestType: agents_pb.ListAgentsRequest,
    responseType: agents_pb.ListAgentsResponse,
    requestSerialize: serialize_optimiq_voice_agents_v1beta2_ListAgentsRequest,
    requestDeserialize: deserialize_optimiq_voice_agents_v1beta2_ListAgentsRequest,
    responseSerialize: serialize_optimiq_voice_agents_v1beta2_ListAgentsResponse,
    responseDeserialize: deserialize_optimiq_voice_agents_v1beta2_ListAgentsResponse,
  },
};

exports.AgentsClient = grpc.makeGenericClientConstructor(AgentsService, 'Agents');
