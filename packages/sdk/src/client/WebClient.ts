import { AclsClient } from "../generated/web/AclsServiceClientPb";
import { AgentsClient } from "../generated/web/AgentsServiceClientPb";
import { ApplicationsClient } from "../generated/web/ApplicationsServiceClientPb";
import { CallsClient } from "../generated/web/CallsServiceClientPb";
import { CredentialsServiceClient } from "../generated/web/CredentialsServiceClientPb";
import { DomainsClient } from "../generated/web/DomainsServiceClientPb";
import { IdentityClient } from "../generated/web/IdentityServiceClientPb";
import { NumbersClient } from "../generated/web/NumbersServiceClientPb";
import { SecretsClient } from "../generated/web/SecretsServiceClientPb";
import { TrunksClient } from "../generated/web/TrunksServiceClientPb";
import { AbstractClient } from "./AbstractClient";
import { TokenRefresherWeb } from "./TokenRefresherWeb";

const DEFAULT_URL = "https://api.optimiq.health";

export class WebClient extends AbstractClient {
  private url: string;

  constructor(
    config: { url?: string; accessKeyId: string } = {
      url: DEFAULT_URL,
      accessKeyId: ""
    }
  ) {
    const { url, accessKeyId } = config;

    super({
      accessKeyId,
      identityClient: new IdentityClient(url ?? DEFAULT_URL, null, null)
    });

    this.url = url ?? DEFAULT_URL;
  }

  getMetadata() {
    return {
      token: this.getAccessToken(),
      accessKeyId: this.getAccessKeyId()
    };
  }

  getApplicationsClient() {
    return new ApplicationsClient(this.url, null, {
      streamInterceptors: [new TokenRefresherWeb(this)]
    });
  }

  getCallsClient() {
    return new CallsClient(this.url, null, {
      streamInterceptors: [new TokenRefresherWeb(this)]
    });
  }

  getIdentityClient() {
    return new IdentityClient(this.url, null, null);
  }

  getSecretsClient() {
    return new SecretsClient(this.url, null, {
      streamInterceptors: [new TokenRefresherWeb(this)]
    });
  }

  getAgentsClient() {
    return new AgentsClient(this.url, null, {
      streamInterceptors: [new TokenRefresherWeb(this)]
    });
  }

  getAclsClient() {
    return new AclsClient(this.url, null, {
      streamInterceptors: [new TokenRefresherWeb(this)]
    });
  }

  getDomainsClient() {
    return new DomainsClient(this.url, null, {
      streamInterceptors: [new TokenRefresherWeb(this)]
    });
  }

  getTrunksClient() {
    return new TrunksClient(this.url, null, {
      streamInterceptors: [new TokenRefresherWeb(this)]
    });
  }

  getNumbersClient() {
    return new NumbersClient(this.url, null, {
      streamInterceptors: [new TokenRefresherWeb(this)]
    });
  }

  getCredentialsClient() {
    return new CredentialsServiceClient(this.url, null, {
      streamInterceptors: [new TokenRefresherWeb(this)]
    });
  }
}
