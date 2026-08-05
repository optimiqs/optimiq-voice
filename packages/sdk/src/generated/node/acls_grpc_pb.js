// GENERATED CODE -- DO NOT EDIT!

'use strict';
var grpc = require('@grpc/grpc-js');
var acls_pb = require('./acls_pb.js');

function serialize_optimiq_voice_acls_v1beta2_Acl(arg) {
  if (!(arg instanceof acls_pb.Acl)) {
    throw new Error('Expected argument of type optimiq_voice.acls.v1beta2.Acl');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_acls_v1beta2_Acl(buffer_arg) {
  return acls_pb.Acl.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_acls_v1beta2_CreateAclRequest(arg) {
  if (!(arg instanceof acls_pb.CreateAclRequest)) {
    throw new Error('Expected argument of type optimiq_voice.acls.v1beta2.CreateAclRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_acls_v1beta2_CreateAclRequest(buffer_arg) {
  return acls_pb.CreateAclRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_acls_v1beta2_CreateAclResponse(arg) {
  if (!(arg instanceof acls_pb.CreateAclResponse)) {
    throw new Error('Expected argument of type optimiq_voice.acls.v1beta2.CreateAclResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_acls_v1beta2_CreateAclResponse(buffer_arg) {
  return acls_pb.CreateAclResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_acls_v1beta2_DeleteAclRequest(arg) {
  if (!(arg instanceof acls_pb.DeleteAclRequest)) {
    throw new Error('Expected argument of type optimiq_voice.acls.v1beta2.DeleteAclRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_acls_v1beta2_DeleteAclRequest(buffer_arg) {
  return acls_pb.DeleteAclRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_acls_v1beta2_DeleteAclResponse(arg) {
  if (!(arg instanceof acls_pb.DeleteAclResponse)) {
    throw new Error('Expected argument of type optimiq_voice.acls.v1beta2.DeleteAclResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_acls_v1beta2_DeleteAclResponse(buffer_arg) {
  return acls_pb.DeleteAclResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_acls_v1beta2_GetAclRequest(arg) {
  if (!(arg instanceof acls_pb.GetAclRequest)) {
    throw new Error('Expected argument of type optimiq_voice.acls.v1beta2.GetAclRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_acls_v1beta2_GetAclRequest(buffer_arg) {
  return acls_pb.GetAclRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_acls_v1beta2_ListAclsRequest(arg) {
  if (!(arg instanceof acls_pb.ListAclsRequest)) {
    throw new Error('Expected argument of type optimiq_voice.acls.v1beta2.ListAclsRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_acls_v1beta2_ListAclsRequest(buffer_arg) {
  return acls_pb.ListAclsRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_acls_v1beta2_ListAclsResponse(arg) {
  if (!(arg instanceof acls_pb.ListAclsResponse)) {
    throw new Error('Expected argument of type optimiq_voice.acls.v1beta2.ListAclsResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_acls_v1beta2_ListAclsResponse(buffer_arg) {
  return acls_pb.ListAclsResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_acls_v1beta2_UpdateAclRequest(arg) {
  if (!(arg instanceof acls_pb.UpdateAclRequest)) {
    throw new Error('Expected argument of type optimiq_voice.acls.v1beta2.UpdateAclRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_acls_v1beta2_UpdateAclRequest(buffer_arg) {
  return acls_pb.UpdateAclRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_optimiq_voice_acls_v1beta2_UpdateAclResponse(arg) {
  if (!(arg instanceof acls_pb.UpdateAclResponse)) {
    throw new Error('Expected argument of type optimiq_voice.acls.v1beta2.UpdateAclResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_optimiq_voice_acls_v1beta2_UpdateAclResponse(buffer_arg) {
  return acls_pb.UpdateAclResponse.deserializeBinary(new Uint8Array(buffer_arg));
}


// AccessControlList(Acl) service definition
var AclsService = exports.AclsService = {
  // Create a new Acl
createAcl: {
    path: '/optimiq_voice.acls.v1beta2.Acls/CreateAcl',
    requestStream: false,
    responseStream: false,
    requestType: acls_pb.CreateAclRequest,
    responseType: acls_pb.CreateAclResponse,
    requestSerialize: serialize_optimiq_voice_acls_v1beta2_CreateAclRequest,
    requestDeserialize: deserialize_optimiq_voice_acls_v1beta2_CreateAclRequest,
    responseSerialize: serialize_optimiq_voice_acls_v1beta2_CreateAclResponse,
    responseDeserialize: deserialize_optimiq_voice_acls_v1beta2_CreateAclResponse,
  },
  // Update an existing Acl
updateAcl: {
    path: '/optimiq_voice.acls.v1beta2.Acls/UpdateAcl',
    requestStream: false,
    responseStream: false,
    requestType: acls_pb.UpdateAclRequest,
    responseType: acls_pb.UpdateAclResponse,
    requestSerialize: serialize_optimiq_voice_acls_v1beta2_UpdateAclRequest,
    requestDeserialize: deserialize_optimiq_voice_acls_v1beta2_UpdateAclRequest,
    responseSerialize: serialize_optimiq_voice_acls_v1beta2_UpdateAclResponse,
    responseDeserialize: deserialize_optimiq_voice_acls_v1beta2_UpdateAclResponse,
  },
  // Get an existing Acl
getAcl: {
    path: '/optimiq_voice.acls.v1beta2.Acls/GetAcl',
    requestStream: false,
    responseStream: false,
    requestType: acls_pb.GetAclRequest,
    responseType: acls_pb.Acl,
    requestSerialize: serialize_optimiq_voice_acls_v1beta2_GetAclRequest,
    requestDeserialize: deserialize_optimiq_voice_acls_v1beta2_GetAclRequest,
    responseSerialize: serialize_optimiq_voice_acls_v1beta2_Acl,
    responseDeserialize: deserialize_optimiq_voice_acls_v1beta2_Acl,
  },
  // Delete an existing Acl
deleteAcl: {
    path: '/optimiq_voice.acls.v1beta2.Acls/DeleteAcl',
    requestStream: false,
    responseStream: false,
    requestType: acls_pb.DeleteAclRequest,
    responseType: acls_pb.DeleteAclResponse,
    requestSerialize: serialize_optimiq_voice_acls_v1beta2_DeleteAclRequest,
    requestDeserialize: deserialize_optimiq_voice_acls_v1beta2_DeleteAclRequest,
    responseSerialize: serialize_optimiq_voice_acls_v1beta2_DeleteAclResponse,
    responseDeserialize: deserialize_optimiq_voice_acls_v1beta2_DeleteAclResponse,
  },
  // Get a list of Acls
listAcls: {
    path: '/optimiq_voice.acls.v1beta2.Acls/ListAcls',
    requestStream: false,
    responseStream: false,
    requestType: acls_pb.ListAclsRequest,
    responseType: acls_pb.ListAclsResponse,
    requestSerialize: serialize_optimiq_voice_acls_v1beta2_ListAclsRequest,
    requestDeserialize: deserialize_optimiq_voice_acls_v1beta2_ListAclsRequest,
    responseSerialize: serialize_optimiq_voice_acls_v1beta2_ListAclsResponse,
    responseDeserialize: deserialize_optimiq_voice_acls_v1beta2_ListAclsResponse,
  },
};

exports.AclsClient = grpc.makeGenericClientConstructor(AclsService, 'Acls');
