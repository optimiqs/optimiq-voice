import {
	createCreateApiKey,
	createCreateUser,
	createCreateUserWithOauth2Code,
	createCreateWorkspace,
	createDeleteApiKey,
	createDeleteUser,
	createDeleteWorkspace,
	createExchangeApiKey,
	createExchangeCredentials,
	createExchangeRefreshToken,
	createGetUser,
	createGetWorkspace,
	createInviteUserToWorkspace,
	createListApiKeys,
	createListWorkspaceMembers,
	createListWorkspaces,
	createRegenerateApiKey,
	createRemoveUserFromWorkspace,
	createResendWorkspaceMembershipInvitation,
	createResetPassword,
	createSendResetPasswordCode,
	createUpdateUser,
	createUpdateWorkspace,
	sendInvite,
} from ".";
import { createDatabaseClient } from "./db";
import { createExchangeOauth2Code } from "./exchanges/createExchangeOauth2Code";
import { IdentityConfig } from "./exchanges/types";
import { createGetPublicKey } from "./getPublicKey";
import { createSendVerificationCode, createVerifyCode } from "./verification";

const serviceDefinitionParams = {
	serviceName: "Identity",
	pckg: "identity",
	proto: "identity.proto",
	version: "v1beta2",
};

function buildIdentityService(identityConfig: IdentityConfig) {
	const db = createDatabaseClient(identityConfig.dbUrl, identityConfig.encryptionKey);

	const service = {
		definition: serviceDefinitionParams,
		handlers: {
			// Workspace operations
			createWorkspace: createCreateWorkspace(db),
			deleteWorkspace: createDeleteWorkspace(db),
			getWorkspace: createGetWorkspace(db),
			updateWorkspace: createUpdateWorkspace(db),
			listWorkspaces: createListWorkspaces(db),
			listWorkspaceMembers: createListWorkspaceMembers(db),
			inviteUserToWorkspace: createInviteUserToWorkspace(db, identityConfig, sendInvite),
			resendWorkspaceMembershipInvitation: createResendWorkspaceMembershipInvitation(
				db,
				identityConfig,
				sendInvite,
			),
			removeUserFromWorkspace: createRemoveUserFromWorkspace(db),
			// User operations
			createUser: createCreateUser(db),
			createUserWithOauth2Code: createCreateUserWithOauth2Code(db, identityConfig),
			getUser: createGetUser(db),
			deleteUser: createDeleteUser(db),
			updateUser: createUpdateUser(db),
			sendResetPasswordCode: createSendResetPasswordCode(db, identityConfig),
			resetPassword: createResetPassword(db),
			// ApiKey operations
			createApiKey: createCreateApiKey(db),
			deleteApiKey: createDeleteApiKey(db),
			listApiKeys: createListApiKeys(db),
			regenerateApiKey: createRegenerateApiKey(db),
			// Exchanges
			exchangeApiKey: createExchangeApiKey(db, identityConfig),
			exchangeCredentials: createExchangeCredentials(db, identityConfig),
			exchangeOauth2Code: createExchangeOauth2Code(db, identityConfig),
			exchangeRefreshToken: createExchangeRefreshToken(db, identityConfig),
			getPublicKey: createGetPublicKey(identityConfig.publicKey),
			// Placeholders for conditional handlers
			sendVerificationCode: undefined as unknown as ReturnType<typeof createSendVerificationCode>,
			verifyCode: undefined as unknown as ReturnType<typeof createVerifyCode>,
		},
	};

	if (
		identityConfig.contactVerificationRequired ||
		identityConfig.twoFactorAuthenticationRequired
	) {
		service.handlers.sendVerificationCode = createSendVerificationCode(db, identityConfig);
		service.handlers.verifyCode = createVerifyCode(db);
	}

	return { ...service, close: () => db.close() };
}

export { buildIdentityService, serviceDefinitionParams };
