import { ListResponse } from "./common";

enum Role {
	USER = "USER",
	WORKSPACE_OWNER = "WORKSPACE_OWNER",
	WORKSPACE_ADMIN = "WORKSPACE_ADMIN",
	WORKSPACE_MEMBER = "WORKSPACE_MEMBER",
}

enum WorkspaceMemberStatus {
	PENDING = "PENDING",
	ACTIVE = "ACTIVE",
}

type Workspace = {
	ref: string;
	name: string;
	ownerRef: string;
	accessKeyId: string;
	createdAt: Date;
	updatedAt: Date;
	owner?: {
		ref: string;
		name: string;
		email: string;
	};
};

type CreateWorkspaceRequest = {
	name: string;
};

type UpdateWorkspaceRequest = {
	ref: string;
	name: string;
};

type ListWorkspacesResponse = ListResponse<Workspace>;

type InviteUserToWorkspaceResponse = {
	workspaceRef: string;
	userRef: string;
};

type InviteUserToWorkspaceRequest = {
	email: string;
	name: string;
	role: Role;
	password: string;
};

type RemoveUserFromWorkspaceRequest = {
	userRef: string;
};

type RemoveUserFromWorkspaceResponse = {
	userRef: string;
};

type ResendWorkspaceMembershipInvitationRequest = {
	userRef: string;
};

type ResendWorkspaceMembershipInvitationResponse = {
	userRef: string;
};

export {
	CreateWorkspaceRequest,
	InviteUserToWorkspaceRequest,
	InviteUserToWorkspaceResponse,
	ListWorkspacesResponse,
	RemoveUserFromWorkspaceRequest,
	RemoveUserFromWorkspaceResponse,
	ResendWorkspaceMembershipInvitationRequest,
	ResendWorkspaceMembershipInvitationResponse,
	UpdateWorkspaceRequest,
	Workspace,
	WorkspaceMemberStatus,
	Role,
};
