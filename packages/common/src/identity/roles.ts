import { Role } from "@optimiq-voice/types";
import { RoleType } from "./types";

const VOICE_SERVICE_ROLE = "VOICE_SERVICE";

const workspaceResourceAccess = [
	"/optimiq_voice.applications.v1beta2.Applications/CreateApplication",
	"/optimiq_voice.applications.v1beta2.Applications/CreateTestToken",
	"/optimiq_voice.applications.v1beta2.Applications/UpdateApplication",
	"/optimiq_voice.applications.v1beta2.Applications/GetApplication",
	"/optimiq_voice.applications.v1beta2.Applications/DeleteApplication",
	"/optimiq_voice.applications.v1beta2.Applications/ListApplications",
	"/optimiq_voice.applications.v1beta2.Applications/EvaluateIntelligence",
	"/optimiq_voice.agents.v1beta2.Agents/CreateAgent",
	"/optimiq_voice.agents.v1beta2.Agents/UpdateAgent",
	"/optimiq_voice.agents.v1beta2.Agents/GetAgent",
	"/optimiq_voice.agents.v1beta2.Agents/DeleteAgent",
	"/optimiq_voice.agents.v1beta2.Agents/ListAgents",
	"/optimiq_voice.acls.v1beta2.Acls/CreateAcl",
	"/optimiq_voice.acls.v1beta2.Acls/UpdateAcl",
	"/optimiq_voice.acls.v1beta2.Acls/ListAcls",
	"/optimiq_voice.acls.v1beta2.Acls/GetAcl",
	"/optimiq_voice.acls.v1beta2.Acls/DeleteAcl",
	"/optimiq_voice.credentials.v1beta2.CredentialsService/CreateCredentials",
	"/optimiq_voice.credentials.v1beta2.CredentialsService/UpdateCredentials",
	"/optimiq_voice.credentials.v1beta2.CredentialsService/GetCredentials",
	"/optimiq_voice.credentials.v1beta2.CredentialsService/DeleteCredentials",
	"/optimiq_voice.credentials.v1beta2.CredentialsService/ListCredentials",
	"/optimiq_voice.domains.v1beta2.Domains/CreateDomain",
	"/optimiq_voice.domains.v1beta2.Domains/UpdateDomain",
	"/optimiq_voice.domains.v1beta2.Domains/GetDomain",
	"/optimiq_voice.domains.v1beta2.Domains/DeleteDomain",
	"/optimiq_voice.domains.v1beta2.Domains/ListDomains",
	"/optimiq_voice.trunks.v1beta2.Trunks/CreateTrunk",
	"/optimiq_voice.trunks.v1beta2.Trunks/UpdateTrunk",
	"/optimiq_voice.trunks.v1beta2.Trunks/GetTrunk",
	"/optimiq_voice.trunks.v1beta2.Trunks/DeleteTrunk",
	"/optimiq_voice.trunks.v1beta2.Trunks/ListTrunks",
	"/optimiq_voice.numbers.v1beta2.Numbers/CreateNumber",
	"/optimiq_voice.numbers.v1beta2.Numbers/UpdateNumber",
	"/optimiq_voice.numbers.v1beta2.Numbers/GetNumber",
	"/optimiq_voice.numbers.v1beta2.Numbers/DeleteNumber",
	"/optimiq_voice.numbers.v1beta2.Numbers/ListNumbers",
	"/optimiq_voice.secrets.v1beta2.Secrets/CreateSecret",
	"/optimiq_voice.secrets.v1beta2.Secrets/UpdateSecret",
	"/optimiq_voice.secrets.v1beta2.Secrets/GetSecret",
	"/optimiq_voice.secrets.v1beta2.Secrets/DeleteSecret",
	"/optimiq_voice.secrets.v1beta2.Secrets/ListSecrets",
	"/optimiq_voice.calls.v1beta2.Calls/CreateCall",
	"/optimiq_voice.calls.v1beta2.Calls/ListCalls",
	"/optimiq_voice.calls.v1beta2.Calls/GetCall",
	"/optimiq_voice.calls.v1beta2.Calls/TrackCall",
	"/optimiq_voice.voice.v1beta2.Voice/CreateSession",
	"/optimiq_voice.identity.v1beta2.Identity/CreateApiKey",
	"/optimiq_voice.identity.v1beta2.Identity/DeleteApiKey",
	"/optimiq_voice.identity.v1beta2.Identity/ListApiKeys",
	"/optimiq_voice.identity.v1beta2.Identity/RegenerateApiKey",
];

const workspaceResourceOwnerOrAdminAccess = [
	"/optimiq_voice.identity.v1beta2.Identity/ListWorkspaceMembers",
	"/optimiq_voice.identity.v1beta2.Identity/InviteUserToWorkspace",
	"/optimiq_voice.identity.v1beta2.Identity/RemoveUserFromWorkspace",
	"/optimiq_voice.identity.v1beta2.Identity/ResendWorkspaceMembershipInvitation",
];

const fullIdentityAccess = [
	"/optimiq_voice.identity.v1beta2.Identity/GetUser",
	"/optimiq_voice.identity.v1beta2.Identity/UpdateUser",
	"/optimiq_voice.identity.v1beta2.Identity/DeleteUser",
	"/optimiq_voice.identity.v1beta2.Identity/CreateWorkspace",
	"/optimiq_voice.identity.v1beta2.Identity/GetWorkspace",
	"/optimiq_voice.identity.v1beta2.Identity/UpdateWorkspace",
	"/optimiq_voice.identity.v1beta2.Identity/ListWorkspaces",
	"/optimiq_voice.identity.v1beta2.Identity/DeleteWorkspace",
	"/optimiq_voice.identity.v1beta2.Identity/RefreshToken",
];

const roles = [
	{
		name: Role.USER,
		description: "Access to User and Workspace endpoints",
		access: [...fullIdentityAccess, ...workspaceResourceAccess],
	},
	{
		name: Role.WORKSPACE_OWNER,
		description: "Access to all endpoints",
		access: [
			...fullIdentityAccess,
			...workspaceResourceAccess,
			...workspaceResourceOwnerOrAdminAccess,
		],
	},
	{
		name: Role.WORKSPACE_ADMIN,
		description: "Access to all endpoints",
		access: [
			...fullIdentityAccess,
			...workspaceResourceAccess,
			...workspaceResourceOwnerOrAdminAccess,
		],
	},
	{
		name: Role.WORKSPACE_MEMBER,
		description: "Access to User and Workspace endpoints",
		access: [
			"/optimiq_voice.identity.v1beta2.Identity/GetUser",
			"/optimiq_voice.identity.v1beta2.Identity/GetWorkspace",
			"/optimiq_voice.identity.v1beta2.Identity/ListWorkspaces",
			...workspaceResourceAccess,
		],
	},
	{
		name: VOICE_SERVICE_ROLE,
		description: "Role with access only to the Voice service endpoint",
		access: [
			"/optimiq_voice.voice.v1beta2.Voice/CreateSession",
			"/optimiq_voice.applications.v1beta2.Applications/GetApplication",
		],
	},
] as RoleType[];

export { VOICE_SERVICE_ROLE, roles, workspaceResourceAccess, workspaceResourceOwnerOrAdminAccess };
