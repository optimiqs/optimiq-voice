import {
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  CreateUserRequest,
  CreateUserResponse,
  CreateUserWithOauth2CodeRequest,
  CreateWorkspaceRequest,
  DeleteApiKeyRequest,
  DeleteApiKeyResponse,
  DeleteUserRequest,
  DeleteUserResponse,
  DeleteWorkspaceRequest,
  DeleteWorkspaceResponse,
  ExchangeApiKeyRequest,
  ExchangeApiKeyResponse,
  ExchangeCredentialsRequest,
  ExchangeCredentialsResponse,
  ExchangeOauth2CodeRequest,
  ExchangeOauth2CodeResponse,
  ExchangeRefreshTokenRequest,
  ExchangeRefreshTokenResponse,
  GetUserRequest,
  GetWorkspaceRequest,
  InviteUserToWorkspaceRequest,
  InviteUserToWorkspaceResponse,
  ListApiKeysRequest,
  ListApiKeysResponse,
  ListWorkspaceMembersRequest,
  ListWorkspaceMembersResponse,
  ListWorkspacesRequest,
  ListWorkspacesResponse,
  RegenerateApiKeyRequest,
  RegenerateApiKeyResponse,
  RemoveUserFromWorkspaceRequest,
  RemoveUserFromWorkspaceResponse,
  ResendWorkspaceMembershipInvitationRequest,
  ResendWorkspaceMembershipInvitationResponse,
  ResetPasswordRequest,
  SendResetPasswordCodeRequest,
  SendVerificationCodeRequest,
  UpdateUserRequest,
  UpdateWorkspaceRequest,
  UpdateWorkspaceResponse,
  User,
  VerifyCodeRequest,
  Workspace
} from "../../generated/web/identity_pb";
import { ClientFunction } from "../types";

type IdentityClient = {
  // ApiKeys
  createApiKey: ClientFunction<CreateApiKeyRequest, CreateApiKeyResponse>;
  regenerateApiKey: ClientFunction<
    RegenerateApiKeyRequest,
    RegenerateApiKeyResponse
  >;
  listApiKeys: ClientFunction<ListApiKeysRequest, ListApiKeysResponse>;
  deleteApiKey: ClientFunction<DeleteApiKeyRequest, DeleteApiKeyResponse>;
  // Exchanges
  exchangeApiKey: ClientFunction<ExchangeApiKeyRequest, ExchangeApiKeyResponse>;
  exchangeCredentials: ClientFunction<
    ExchangeCredentialsRequest,
    ExchangeCredentialsResponse
  >;
  exchangeOauth2Code: ClientFunction<
    ExchangeOauth2CodeRequest,
    ExchangeOauth2CodeResponse
  >;
  exchangeRefreshToken: ClientFunction<
    ExchangeRefreshTokenRequest,
    ExchangeRefreshTokenResponse
  >;
  // User
  createUser: ClientFunction<CreateUserRequest, CreateUserResponse>;
  createUserWithOauth2Code: ClientFunction<
    CreateUserWithOauth2CodeRequest,
    ExchangeCredentialsResponse
  >;
  getUser: ClientFunction<GetUserRequest, User>;
  updateUser: ClientFunction<UpdateUserRequest, CreateUserResponse>;
  deleteUser: ClientFunction<DeleteUserRequest, DeleteUserResponse>;
  sendVerificationCode: ClientFunction<SendVerificationCodeRequest, never>;
  verifyCode: ClientFunction<VerifyCodeRequest, never>;
  sendResetPasswordCode: ClientFunction<SendResetPasswordCodeRequest, never>;
  resetPassword: ClientFunction<ResetPasswordRequest, never>;
  // Workspaces
  createWorkspace: ClientFunction<CreateWorkspaceRequest, CreateUserResponse>;
  getWorkspace: ClientFunction<GetWorkspaceRequest, Workspace>;
  listWorkspaces: ClientFunction<ListWorkspacesRequest, ListWorkspacesResponse>;
  updateWorkspace: ClientFunction<
    UpdateWorkspaceRequest,
    UpdateWorkspaceResponse
  >;
  inviteUserToWorkspace: ClientFunction<
    InviteUserToWorkspaceRequest,
    InviteUserToWorkspaceResponse
  >;
  resendWorkspaceMembershipInvitation: ClientFunction<
    ResendWorkspaceMembershipInvitationRequest,
    ResendWorkspaceMembershipInvitationResponse
  >;
  listWorkspaceMembers: ClientFunction<
    ListWorkspaceMembersRequest,
    ListWorkspaceMembersResponse
  >;
  removeUserFromWorkspace: ClientFunction<
    RemoveUserFromWorkspaceRequest,
    RemoveUserFromWorkspaceResponse
  >;
  deleteWorkspace: ClientFunction<
    DeleteWorkspaceRequest,
    DeleteWorkspaceResponse
  >;
};

export { IdentityClient };
