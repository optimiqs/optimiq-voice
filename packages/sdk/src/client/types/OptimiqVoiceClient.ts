import { AclsClient } from "./AclsClient";
import { AgentsClient } from "./AgentsClient";
import { ApplicationsClient } from "./ApplicationsClient";
import { CallsClient } from "./CallsClient";
import { CredentialsClient } from "./CredentialsClient";
import { DomainsClient } from "./DomainsClient";
import { IdentityClient } from "./IdentityClient";
import { NumbersClient } from "./NumbersClient";
import { SecretsClient } from "./SecretsClient";
import { TrunksClient } from "./TrunksClient";

interface OptimiqVoiceClient {
	getAccessToken(): string;
	getAccessKeyId(): string;
	getApplicationsClient(): ApplicationsClient;
	getCallsClient(): CallsClient;
	getIdentityClient(): IdentityClient;
	getSecretsClient(): SecretsClient;
	getAgentsClient(): AgentsClient;
	getNumbersClient(): NumbersClient;
	getCredentialsClient(): CredentialsClient;
	getDomainsClient(): DomainsClient;
	getTrunksClient(): TrunksClient;
	getAclsClient(): AclsClient;
	getMetadata(): unknown;
	refreshToken(): Promise<void>;
}

export { OptimiqVoiceClient };
