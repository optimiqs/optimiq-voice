import { ListRequest, ListResponse } from "./common";
import { Role, WorkspaceMemberStatus } from "./workspaces.types";

type User = {
  ref: string;
  email: string;
  name: string;
  avatar: string;
  createdAt: Date;
  updatedAt: Date;
};

type Member = {
  ref: string;
  userRef: string;
  name: string;
  email: string;
  role: Role;
  status: WorkspaceMemberStatus;
  createdAt: Date;
  updatedAt: Date;
};

type CreateUserRequest = {
  name: string;
  email: string;
  password: string;
  avatar: string;
  phone?: string;
};

type CreateUserWithOauth2CodeRequest = {
  code: string;
};

type CreateApiKeyResponse = {
  ref: string;
  accessKeyId: string;
  accessKeySecret: string;
};

type UpdateUserRequest = {
  ref: string;
  name?: string;
  password?: string;
  avatar?: string;
  phone?: string;
};

type CreateApiKeyRequest = {
  role: Role;
  expiresAt?: number;
};

type RegenerateApiKeyResponse = {
  ref: string;
  accessKeyId: string;
  accessKeySecret: string;
};

type ApiKey = {
  ref: string;
  accessKeyId: string;
  role: Role;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type SendResetPasswordCodeRequest = {
  username: string;
  resetPasswordUrl: string;
};

type ResetPasswordRequest = {
  username: string;
  password: string;
  verificationCode: string;
};

type ExchangeCredentialsResponse = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
};

type ListApiKeysRequest = ListRequest;

type ListApiKeysResponse = ListResponse<ApiKey>;

type ListWorkspaceMembersRequest = ListRequest;

type ListWorkspaceMembersResponse = ListResponse<Member>;

export {
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  CreateUserWithOauth2CodeRequest,
  CreateUserRequest,
  ListApiKeysRequest,
  ListApiKeysResponse,
  RegenerateApiKeyResponse,
  ListWorkspaceMembersRequest,
  ListWorkspaceMembersResponse,
  UpdateUserRequest,
  SendResetPasswordCodeRequest,
  ResetPasswordRequest,
  User,
  ExchangeCredentialsResponse
};
