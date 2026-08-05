import {
  BaseApiObject,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  ListApiKeysRequest,
  ListApiKeysResponse,
  RegenerateApiKeyResponse,
  Role
} from "@optimiq-voice/types";
import { makeRpcRequest } from "./client/makeRpcRequest";
import { OptimiqVoiceClient } from "./client/types";
import {
  ApiKey as ApiKeyPB,
  CreateApiKeyRequest as CreateApiKeyRequestPB,
  CreateApiKeyResponse as CreateApiKeyResponsePB,
  DeleteApiKeyRequest as DeleteApiKeyRequestPB,
  DeleteApiKeyResponse as DeleteApiKeyResponsePB,
  ListApiKeysRequest as ListApiKeysRequestPB,
  ListApiKeysResponse as ListApiKeysResponsePB,
  RegenerateApiKeyRequest as RegenerateApiKeyRequestPB,
  RegenerateApiKeyResponse as RegenerateApiKeyResponsePB
} from "./generated/node/identity_pb";

/**
 * @classdesc Optimiq Voice ApiKeys, part of the Optimiq Voice Identity subsystem,
 * allows you to create, update, retrieve, and delete ApiKeys for your deployment.
 * Note that an active Optimiq Voice deployment is required.
 *
 * @example
 *
 * const SDK = require("@optimiq-voice/sdk");
 *
 * async function main(request) {
 *   const apiKey = "your-api-key";
 *   const apiSecret = "your-api-secret"
 *   const accessKeyId = "WO00000000000000000000000000000000";
 *
 *   try {
 *     const client = SDK.Client({ accessKeyId });
 *     await client.loginWithApiKey(apiKey, apiSecret);
 *
 *     const apiKeys = new SDK.ApiKeys(client);
 *     const response = await apiKeys.createApiKey(request);
 *
 *     console.log(response); // successful response
 *   } catch (e) {
 *     console.error(e); // an error occurred
 *   }
 * }
 *
 * const request = {
 *   role: "WORKSPACE_ADMIN"
 * };
 *
 * main(request);
 */
class ApiKeys {
  private readonly client: OptimiqVoiceClient;
  /**
   * Constructs a new ApiKeys object.
   *
   * @param {OptimiqVoiceClient} client - Client object with underlying implementations to make requests to Optimiq Voice's API
   * @see AbstractClient
   * @see OptimiqVoiceClient
   */
  constructor(client: OptimiqVoiceClient) {
    this.client = client;
  }

  /**
   * Creates a new ApiKey for a Workspace.
   *
   * @param {CreateApiKeyRequest} request - The request object that contains the necessary information to create a new ApiKey
   * @param {Role} request.role - The role of the ApiKey
   * @return {Promise<CreateApiKeyResponse>} - The response object that contains the reference to the created ApiKey
   * @example
   * const apiKeys = new SDK.ApiKeys(client); // Existing client object
   *
   * const request = {
   *   role: "WORKSPACE_ADMIN"
   * };
   *
   * apiKeys
   *   .createApiKey(request)
   *   .then(console.log) // successful response
   *   .catch(console.error); // an error occurred
   */
  async createApiKey(
    request: CreateApiKeyRequest
  ): Promise<CreateApiKeyResponse> {
    const client = this.client.getIdentityClient();
    return await makeRpcRequest<
      CreateApiKeyRequestPB,
      CreateApiKeyResponsePB,
      CreateApiKeyRequest,
      CreateApiKeyResponse
    >({
      method: client.createApiKey.bind(client),
      requestPBObjectConstructor: CreateApiKeyRequestPB,
      metadata: this.client.getMetadata(),
      request,
      enumMapping: [["role", Role]]
    });
  }

  /**
   * Regenerates an existing ApiKey for a Workspace.
   * Note that this operation is irreversible.
   *
   * @param {string} ref - The reference of the ApiKey to regenerate
   * @return {Promise<CreateApiKeyResponse>} - The response object that contains the reference to the regenerated ApiKey
   * @example
   * const apiKeys = new SDK.ApiKeys(client); // Existing client object
   *
   * const ref = "00000000-0000-0000-0000-000000000000";
   *
   * apiKeys
   *   .regenerateApiKey(ref)
   *   .then(console.log) // successful response
   *   .catch(console.error); // an error occurred
   */
  async regenerateApiKey(ref: string): Promise<CreateApiKeyResponse> {
    const client = this.client.getIdentityClient();
    return await makeRpcRequest<
      RegenerateApiKeyRequestPB,
      RegenerateApiKeyResponsePB,
      BaseApiObject,
      RegenerateApiKeyResponse
    >({
      method: client.regenerateApiKey.bind(client),
      requestPBObjectConstructor: RegenerateApiKeyRequestPB,
      metadata: this.client.getMetadata(),
      request: { ref }
    });
  }

  /**
   * Retrieves a list of ApiKeys from a Workspace.
   *
   * @param {ListApiKeysRequest} request - The request object that contains the necessary information to retrieve a list of ApiKeys
   * @param {number} request.pageSize - The number of ApiKeys to retrieve
   * @param {string} request.pageToken - The token to retrieve the next page of ApiKeys
   * @return {Promise<ListApiKeysResponse>} - The response object that contains the list of ApiKeys
   * @example
   * const apiKeys = new SDK.ApiKeys(client); // Existing client object
   *
   * const request = {
   *   pageSize: 10,
   *   pageToken: "00000000-0000-0000-0000-000000000000"
   * };
   *
   * apiKeys
   *   .listApiKeys(request)
   *   .then(console.log) // successful response
   *   .catch(console.error); // an error occurred
   */
  async listApiKeys(request: ListApiKeysRequest): Promise<ListApiKeysResponse> {
    const applicationsClient = this.client.getIdentityClient();
    return await makeRpcRequest<
      ListApiKeysRequestPB,
      ListApiKeysResponsePB,
      ListApiKeysRequest,
      ListApiKeysResponse
    >({
      method: applicationsClient.listApiKeys.bind(applicationsClient),
      requestPBObjectConstructor: ListApiKeysRequestPB,
      metadata: this.client.getMetadata(),
      request,
      repeatableObjectMapping: [["itemsList", ApiKeyPB]]
    });
  }

  /**
   * Deletes an existing ApiKey from Optimiq Voice.
   * Note that this operation is irreversible.
   *
   * @param {string} ref - The reference of the ApiKey to delete
   * @return {Promise<BaseApiObject>} - The response object that contains the reference to the deleted ApiKey
   * @example
   * const apiKeys = new SDK.ApiKeys(client); // Existing client object
   *
   * const ref = "00000000-0000-0000-0000-000000000000";
   *
   * apiKeys
   *   .deleteApiKey(ref)
   *   .then(console.log) // successful response
   *   .catch(console.error); // an error occurred
   */
  async deleteApiKey(ref: string): Promise<BaseApiObject> {
    const client = this.client.getIdentityClient();
    return await makeRpcRequest<
      DeleteApiKeyRequestPB,
      DeleteApiKeyResponsePB,
      BaseApiObject,
      BaseApiObject
    >({
      method: client.deleteApiKey.bind(client),
      requestPBObjectConstructor: DeleteApiKeyRequestPB,
      metadata: this.client.getMetadata(),
      request: { ref }
    });
  }
}

export { ApiKeys };
