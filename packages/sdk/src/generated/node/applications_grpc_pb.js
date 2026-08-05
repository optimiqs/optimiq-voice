// GENERATED CODE -- DO NOT EDIT!

'use strict';
var grpc = require('@grpc/grpc-js');
var applications_pb = require('./applications_pb.js');
var google_protobuf_struct_pb = require('google-protobuf/google/protobuf/struct_pb.js');
var google_protobuf_empty_pb = require('google-protobuf/google/protobuf/empty_pb.js');

function serialize_google_protobuf_Empty(arg) {
  if (!(arg instanceof google_protobuf_empty_pb.Empty)) {
    throw new Error('Expected argument of type google.protobuf.Empty');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_google_protobuf_Empty(buffer_arg) {
  return google_protobuf_empty_pb.Empty.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_Application(arg) {
  if (!(arg instanceof applications_pb.Application)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.Application');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_Application(buffer_arg) {
  return applications_pb.Application.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_CreateApplicationRequest(arg) {
  if (!(arg instanceof applications_pb.CreateApplicationRequest)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.CreateApplicationRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_CreateApplicationRequest(buffer_arg) {
  return applications_pb.CreateApplicationRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_CreateApplicationResponse(arg) {
  if (!(arg instanceof applications_pb.CreateApplicationResponse)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.CreateApplicationResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_CreateApplicationResponse(buffer_arg) {
  return applications_pb.CreateApplicationResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_DeleteApplicationRequest(arg) {
  if (!(arg instanceof applications_pb.DeleteApplicationRequest)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.DeleteApplicationRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_DeleteApplicationRequest(buffer_arg) {
  return applications_pb.DeleteApplicationRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_DeleteApplicationResponse(arg) {
  if (!(arg instanceof applications_pb.DeleteApplicationResponse)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.DeleteApplicationResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_DeleteApplicationResponse(buffer_arg) {
  return applications_pb.DeleteApplicationResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_EvaluateIntelligenceEvent(arg) {
  if (!(arg instanceof applications_pb.EvaluateIntelligenceEvent)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.EvaluateIntelligenceEvent');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_EvaluateIntelligenceEvent(buffer_arg) {
  return applications_pb.EvaluateIntelligenceEvent.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_EvaluateIntelligenceRequest(arg) {
  if (!(arg instanceof applications_pb.EvaluateIntelligenceRequest)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.EvaluateIntelligenceRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_EvaluateIntelligenceRequest(buffer_arg) {
  return applications_pb.EvaluateIntelligenceRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_GetApplicationRequest(arg) {
  if (!(arg instanceof applications_pb.GetApplicationRequest)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.GetApplicationRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_GetApplicationRequest(buffer_arg) {
  return applications_pb.GetApplicationRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_ListApplicationsRequest(arg) {
  if (!(arg instanceof applications_pb.ListApplicationsRequest)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.ListApplicationsRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_ListApplicationsRequest(buffer_arg) {
  return applications_pb.ListApplicationsRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_ListApplicationsResponse(arg) {
  if (!(arg instanceof applications_pb.ListApplicationsResponse)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.ListApplicationsResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_ListApplicationsResponse(buffer_arg) {
  return applications_pb.ListApplicationsResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_TestTokenResponse(arg) {
  if (!(arg instanceof applications_pb.TestTokenResponse)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.TestTokenResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_TestTokenResponse(buffer_arg) {
  return applications_pb.TestTokenResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_UpdateApplicationRequest(arg) {
  if (!(arg instanceof applications_pb.UpdateApplicationRequest)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.UpdateApplicationRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_UpdateApplicationRequest(buffer_arg) {
  return applications_pb.UpdateApplicationRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_applications_v1beta2_UpdateApplicationResponse(arg) {
  if (!(arg instanceof applications_pb.UpdateApplicationResponse)) {
    throw new Error('Expected argument of type optimiq_voice.applications.v1beta2.UpdateApplicationResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_applications_v1beta2_UpdateApplicationResponse(buffer_arg) {
  return applications_pb.UpdateApplicationResponse.deserializeBinary(new Uint8Array(buffer_arg));
}


// Applications service definition
var ApplicationsService = exports.ApplicationsService = {
  // Create a new application
createApplication: {
    path: '/optimiq_voice.applications.v1beta2.Applications/CreateApplication',
    requestStream: false,
    responseStream: false,
    requestType: applications_pb.CreateApplicationRequest,
    responseType: applications_pb.CreateApplicationResponse,
    requestSerialize: serialize_optimiq_voice_applications_v1beta2_CreateApplicationRequest,
    requestDeserialize: deserialize_optimiq_voice_applications_v1beta2_CreateApplicationRequest,
    responseSerialize: serialize_optimiq_voice_applications_v1beta2_CreateApplicationResponse,
    responseDeserialize: deserialize_optimiq_voice_applications_v1beta2_CreateApplicationResponse,
  },
  // Get an application
getApplication: {
    path: '/optimiq_voice.applications.v1beta2.Applications/GetApplication',
    requestStream: false,
    responseStream: false,
    requestType: applications_pb.GetApplicationRequest,
    responseType: applications_pb.Application,
    requestSerialize: serialize_optimiq_voice_applications_v1beta2_GetApplicationRequest,
    requestDeserialize: deserialize_optimiq_voice_applications_v1beta2_GetApplicationRequest,
    responseSerialize: serialize_optimiq_voice_applications_v1beta2_Application,
    responseDeserialize: deserialize_optimiq_voice_applications_v1beta2_Application,
  },
  // List applications
listApplications: {
    path: '/optimiq_voice.applications.v1beta2.Applications/ListApplications',
    requestStream: false,
    responseStream: false,
    requestType: applications_pb.ListApplicationsRequest,
    responseType: applications_pb.ListApplicationsResponse,
    requestSerialize: serialize_optimiq_voice_applications_v1beta2_ListApplicationsRequest,
    requestDeserialize: deserialize_optimiq_voice_applications_v1beta2_ListApplicationsRequest,
    responseSerialize: serialize_optimiq_voice_applications_v1beta2_ListApplicationsResponse,
    responseDeserialize: deserialize_optimiq_voice_applications_v1beta2_ListApplicationsResponse,
  },
  // Update an application
updateApplication: {
    path: '/optimiq_voice.applications.v1beta2.Applications/UpdateApplication',
    requestStream: false,
    responseStream: false,
    requestType: applications_pb.UpdateApplicationRequest,
    responseType: applications_pb.UpdateApplicationResponse,
    requestSerialize: serialize_optimiq_voice_applications_v1beta2_UpdateApplicationRequest,
    requestDeserialize: deserialize_optimiq_voice_applications_v1beta2_UpdateApplicationRequest,
    responseSerialize: serialize_optimiq_voice_applications_v1beta2_UpdateApplicationResponse,
    responseDeserialize: deserialize_optimiq_voice_applications_v1beta2_UpdateApplicationResponse,
  },
  // Delete an application
deleteApplication: {
    path: '/optimiq_voice.applications.v1beta2.Applications/DeleteApplication',
    requestStream: false,
    responseStream: false,
    requestType: applications_pb.DeleteApplicationRequest,
    responseType: applications_pb.DeleteApplicationResponse,
    requestSerialize: serialize_optimiq_voice_applications_v1beta2_DeleteApplicationRequest,
    requestDeserialize: deserialize_optimiq_voice_applications_v1beta2_DeleteApplicationRequest,
    responseSerialize: serialize_optimiq_voice_applications_v1beta2_DeleteApplicationResponse,
    responseDeserialize: deserialize_optimiq_voice_applications_v1beta2_DeleteApplicationResponse,
  },
  // Evaluate the intelligence for an Autopilot application (server streaming)
evaluateIntelligence: {
    path: '/optimiq_voice.applications.v1beta2.Applications/EvaluateIntelligence',
    requestStream: false,
    responseStream: true,
    requestType: applications_pb.EvaluateIntelligenceRequest,
    responseType: applications_pb.EvaluateIntelligenceEvent,
    requestSerialize: serialize_optimiq_voice_applications_v1beta2_EvaluateIntelligenceRequest,
    requestDeserialize: deserialize_optimiq_voice_applications_v1beta2_EvaluateIntelligenceRequest,
    responseSerialize: serialize_optimiq_voice_applications_v1beta2_EvaluateIntelligenceEvent,
    responseDeserialize: deserialize_optimiq_voice_applications_v1beta2_EvaluateIntelligenceEvent,
  },
  // Create an Ephemeral Agent to perform test calls to an application
createTestToken: {
    path: '/optimiq_voice.applications.v1beta2.Applications/CreateTestToken',
    requestStream: false,
    responseStream: false,
    requestType: google_protobuf_empty_pb.Empty,
    responseType: applications_pb.TestTokenResponse,
    requestSerialize: serialize_google_protobuf_Empty,
    requestDeserialize: deserialize_google_protobuf_Empty,
    responseSerialize: serialize_optimiq_voice_applications_v1beta2_TestTokenResponse,
    responseDeserialize: deserialize_optimiq_voice_applications_v1beta2_TestTokenResponse,
  },
};

exports.ApplicationsClient = grpc.makeGenericClientConstructor(ApplicationsService, 'Applications');
