import { Client } from "ari-client";
import { AuthzClient } from "@optimiq-voice/authz";
import { VoiceClientConfig } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { AUTHZ_SERVICE_ENABLED, AUTHZ_SERVICE_HOST, AUTHZ_SERVICE_PORT } from "../../envs";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

class AuthorizationHandler {
	private config: VoiceClientConfig;
	private ari: Client;

	constructor(params: { config: VoiceClientConfig; ari: Client }) {
		this.config = params.config;
		this.ari = params.ari;
	}

	async checkAuthorization(): Promise<boolean> {
		if (!AUTHZ_SERVICE_ENABLED) {
			return true;
		}

		const { mediaSessionRef: channelId, accessKeyId } = this.config;

		try {
			const authz = new AuthzClient(`${AUTHZ_SERVICE_HOST}:${AUTHZ_SERVICE_PORT}`);

			const authorized = await authz.checkSessionAuthorized({ accessKeyId });

			if (!authorized) {
				logger.verbose("rejected unauthorized session", { channelId });
				await this.handleUnauthorizedSession();
				return false;
			}

			return true;
		} catch (e) {
			logger.error("authz service error", e);
			await this.handleUnauthorizedSession();
			return false;
		}
	}

	private async handleUnauthorizedSession(): Promise<void> {
		const { mediaSessionRef: channelId } = this.config;

		try {
			await this.ari.channels.answer({ channelId });
			await this.ari.channels.play({ channelId, media: "sound:unavailable" });
			await new Promise((resolve) => setTimeout(resolve, 2000));
			await this.ari.channels.hangup({ channelId });
		} catch (e) {
			logger.error("error handling unauthorized session", e);
		}
	}
}

export { AuthorizationHandler };
