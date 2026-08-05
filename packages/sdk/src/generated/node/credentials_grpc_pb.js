// GENERATED CODE -- DO NOT EDIT!

'use strict';
var grpc = require('@grpc/grpc-js');
var credentials_pb = require('./credentials_pb.js');

function serialize_optimiq_voice_credentials_v1beta2_CreateCredentialsRequest(arg) {
  if (!(arg instanceof credentials_pb.CreateCredentialsRequest)) {
    throw new Error('Expected argument of type optimiq_voice.credentials.v1beta2.CreateCredentialsRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_credentials_v1beta2_CreateCredentialsRequest(buffer_arg) {
  return credentials_pb.CreateCredentialsRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_credentials_v1beta2_CreateCredentialsResponse(arg) {
  if (!(arg instanceof credentials_pb.CreateCredentialsResponse)) {
    throw new Error('Expected argument of type optimiq_voice.credentials.v1beta2.CreateCredentialsResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_credentials_v1beta2_CreateCredentialsResponse(buffer_arg) {
  return credentials_pb.CreateCredentialsResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_credentials_v1beta2_Credentials(arg) {
  if (!(arg instanceof credentials_pb.Credentials)) {
    throw new Error('Expected argument of type optimiq_voice.credentials.v1beta2.Credentials');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_credentials_v1beta2_Credentials(buffer_arg) {
  return credentials_pb.Credentials.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_credentials_v1beta2_DeleteCredentialsRequest(arg) {
  if (!(arg instanceof credentials_pb.DeleteCredentialsRequest)) {
    throw new Error('Expected argument of type optimiq_voice.credentials.v1beta2.DeleteCredentialsRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_credentials_v1beta2_DeleteCredentialsRequest(buffer_arg) {
  return credentials_pb.DeleteCredentialsRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_credentials_v1beta2_DeleteCredentialsResponse(arg) {
  if (!(arg instanceof credentials_pb.DeleteCredentialsResponse)) {
    throw new Error('Expected argument of type optimiq_voice.credentials.v1beta2.DeleteCredentialsResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_credentials_v1beta2_DeleteCredentialsResponse(buffer_arg) {
  return credentials_pb.DeleteCredentialsResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_credentials_v1beta2_GetCredentialsRequest(arg) {
  if (!(arg instanceof credentials_pb.GetCredentialsRequest)) {
    throw new Error('Expected argument of type optimiq_voice.credentials.v1beta2.GetCredentialsRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_credentials_v1beta2_GetCredentialsRequest(buffer_arg) {
  return credentials_pb.GetCredentialsRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_credentials_v1beta2_ListCredentialsRequest(arg) {
  if (!(arg instanceof credentials_pb.ListCredentialsRequest)) {
    throw new Error('Expected argument of type optimiq_voice.credentials.v1beta2.ListCredentialsRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_credentials_v1beta2_ListCredentialsRequest(buffer_arg) {
  return credentials_pb.ListCredentialsRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_credentials_v1beta2_ListCredentialsResponse(arg) {
  if (!(arg instanceof credentials_pb.ListCredentialsResponse)) {
    throw new Error('Expected argument of type optimiq_voice.credentials.v1beta2.ListCredentialsResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_credentials_v1beta2_ListCredentialsResponse(buffer_arg) {
  return credentials_pb.ListCredentialsResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_credentials_v1beta2_UpdateCredentialsRequest(arg) {
  if (!(arg instanceof credentials_pb.UpdateCredentialsRequest)) {
    throw new Error('Expected argument of type optimiq_voice.credentials.v1beta2.UpdateCredentialsRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_credentials_v1beta2_UpdateCredentialsRequest(buffer_arg) {
  return credentials_pb.UpdateCredentialsRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_credentials_v1beta2_UpdateCredentialsResponse(arg) {
  if (!(arg instanceof credentials_pb.UpdateCredentialsResponse)) {
    throw new Error('Expected argument of type optimiq_voice.credentials.v1beta2.UpdateCredentialsResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_credentials_v1beta2_UpdateCredentialsResponse(buffer_arg) {
  return credentials_pb.UpdateCredentialsResponse.deserializeBinary(new Uint8Array(buffer_arg));
}


// The Credentials service definition
var CredentialsServiceService = exports.CredentialsServiceService = {
  // Creates a new set of Credentials
createCredentials: {
    path: '/optimiq_voice.credentials.v1beta2.CredentialsService/CreateCredentials',
    requestStream: false,
    responseStream: false,
    requestType: credentials_pb.CreateCredentialsRequest,
    responseType: credentials_pb.CreateCredentialsResponse,
    requestSerialize: serialize_optimiq_voice_credentials_v1beta2_CreateCredentialsRequest,
    requestDeserialize: deserialize_optimiq_voice_credentials_v1beta2_CreateCredentialsRequest,
    responseSerialize: serialize_optimiq_voice_credentials_v1beta2_CreateCredentialsResponse,
    responseDeserialize: deserialize_optimiq_voice_credentials_v1beta2_CreateCredentialsResponse,
  },
  // Updates an existing set of Credentials
updateCredentials: {
    path: '/optimiq_voice.credentials.v1beta2.CredentialsService/UpdateCredentials',
    requestStream: false,
    responseStream: false,
    requestType: credentials_pb.UpdateCredentialsRequest,
    responseType: credentials_pb.UpdateCredentialsResponse,
    requestSerialize: serialize_optimiq_voice_credentials_v1beta2_UpdateCredentialsRequest,
    requestDeserialize: deserialize_optimiq_voice_credentials_v1beta2_UpdateCredentialsRequest,
    responseSerialize: serialize_optimiq_voice_credentials_v1beta2_UpdateCredentialsResponse,
    responseDeserialize: deserialize_optimiq_voice_credentials_v1beta2_UpdateCredentialsResponse,
  },
  // Gets the details of a given set of Credentials
getCredentials: {
    path: '/optimiq_voice.credentials.v1beta2.CredentialsService/GetCredentials',
    requestStream: false,
    responseStream: false,
    requestType: credentials_pb.GetCredentialsRequest,
    responseType: credentials_pb.Credentials,
    requestSerialize: serialize_optimiq_voice_credentials_v1beta2_GetCredentialsRequest,
    requestDeserialize: deserialize_optimiq_voice_credentials_v1beta2_GetCredentialsRequest,
    responseSerialize: serialize_optimiq_voice_credentials_v1beta2_Credentials,
    responseDeserialize: deserialize_optimiq_voice_credentials_v1beta2_Credentials,
  },
  // Deletes an existing set of Credentials
deleteCredentials: {
    path: '/optimiq_voice.credentials.v1beta2.CredentialsService/DeleteCredentials',
    requestStream: false,
    responseStream: false,
    requestType: credentials_pb.DeleteCredentialsRequest,
    responseType: credentials_pb.DeleteCredentialsResponse,
    requestSerialize: serialize_optimiq_voice_credentials_v1beta2_DeleteCredentialsRequest,
    requestDeserialize: deserialize_optimiq_voice_credentials_v1beta2_DeleteCredentialsRequest,
    responseSerialize: serialize_optimiq_voice_credentials_v1beta2_DeleteCredentialsResponse,
    responseDeserialize: deserialize_optimiq_voice_credentials_v1beta2_DeleteCredentialsResponse,
  },
  // Lists all Credentials
listCredentials: {
    path: '/optimiq_voice.credentials.v1beta2.CredentialsService/ListCredentials',
    requestStream: false,
    responseStream: false,
    requestType: credentials_pb.ListCredentialsRequest,
    responseType: credentials_pb.ListCredentialsResponse,
    requestSerialize: serialize_optimiq_voice_credentials_v1beta2_ListCredentialsRequest,
    requestDeserialize: deserialize_optimiq_voice_credentials_v1beta2_ListCredentialsRequest,
    responseSerialize: serialize_optimiq_voice_credentials_v1beta2_ListCredentialsResponse,
    responseDeserialize: deserialize_optimiq_voice_credentials_v1beta2_ListCredentialsResponse,
  },
};

exports.CredentialsServiceClient = grpc.makeGenericClientConstructor(CredentialsServiceService, 'CredentialsService');
