import { Channel, Client, StasisStart } from "ari-client";
import { v4 as uuidv4 } from "uuid";
import { getLogger } from "@optimiq-voice/logger";
import { requireAuthRuntime } from "../auth/auth-platform.registry";
import { createCallAccessTokenMinter } from "../auth/call-token.service";
import { UnmappedAccessKeyError } from "../auth/legacy-access-key.repository";
import { mapCallDirectionToEnum } from "../events/mapCallDirectionToEnum";
import { VoiceClientImpl } from "./client";
import { CreateContainer } from "./integrations/types";
import { ChannelVar, VoiceClient } from "./types";
import { createGetChannelVarWithoutThrow } from "./utils/createGetChannelVarWithoutThrow";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * Mints the per-call `sessionToken` with better-auth (identity-removal **Step 4 item 4**).
 *
 * The identity signer is gone from this path: no `createGenerateCallAccessToken`, no
 * `identityConfig`, no `.keys/private.pem`, no RS256. The token is signed with the key
 * better-auth manages in the `jwks` table, and `packages/voice` verifies it against
 * `GET /api/auth/jwks` (`createCallTokenVerifier`, shipped in Step 4 item 2). The two halves ship
 * together on purpose — the plan is explicit that deploying them separately leaves the voice
 * server verifying tokens the API does not mint.
 *
 * `createContainer(appRef)` still yields the legacy `WO…` access key, because
 * `applications.access_key_id` is not rewritten until Step 5. It is translated to the tenant's
 * `organization.id` through the Step 2 mapping, so the token carries a real tenant claim instead
 * of a legacy string. When Step 5 lands, `createContainer` returns the organization id directly
 * and the lookup below is deleted.
 *
 * **Fail closed.** No auth slice, or an access key that was never migrated, means no token and no
 * call — there is no unauthenticated fallback. `skipTokenVerification` on the voice side stays a
 * development-only escape hatch (`NODE_ENV=development` **and** no `AUTH_URL`); with this flip an
 * integration environment no longer needs it, because the API mints what the voice server
 * verifies.
 */

// Note: By the time the call arrives here the owner of the app MUST be authenticated
function createCreateVoiceClient(createContainer: CreateContainer) {
	return async function createVoiceClient(params: {
		ari: Client;
		event: StasisStart;
		channel: Channel;
	}): Promise<VoiceClient> {
		const { ari, event, channel } = params;
		const { id: mediaSessionRef, caller } = event.channel;
		const { name: callerName, number: callerNumber } = caller;

		const getChannelVar = createGetChannelVarWithoutThrow(channel);

		// Variables set by Asterisk's dialplan
		const callDirection = (await getChannelVar(ChannelVar.CALL_DIRECTION))?.value;
		const appRef = (await getChannelVar(ChannelVar.APP_REF))?.value;
		const ingressNumber = (await getChannelVar(ChannelVar.INGRESS_NUMBER))?.value || "";

		// Try to get callRef from channel variable (set by dialplan from X-Call-Ref header for API-originated calls)
		// If not found, generate a new UUID (for PSTN-terminated calls)
		const callRefFromChannel = (await getChannelVar(ChannelVar.CALL_REF))?.value;
		const callRef = callRefFromChannel || uuidv4();

		const { accessKeyId, endpoint, tts, stt } = await createContainer(appRef);

		const { platform, legacyAccessKeys } = requireAuthRuntime("the per-call access token");
		const organizationId = await legacyAccessKeys.findOrganizationId(accessKeyId);
		if (!organizationId) {
			throw new UnmappedAccessKeyError(accessKeyId);
		}

		const sessionToken = await createCallAccessTokenMinter(platform)({
			organizationId,
			appRef,
			callRef,
		});

		const metadataStr = (await getChannelVar(ChannelVar.METADATA))?.value ?? "{}";

		const config = {
			appRef,
			mediaSessionRef,
			callRef,
			// The wire field keeps its name during coexistence; the VALUE is the organization id
			// now, matching the `accessKeyId` claim on the token itself. Renamed in Step 9.
			accessKeyId: organizationId,
			endpoint,
			callerName,
			callerNumber,
			ingressNumber,
			sessionToken,
			callDirection: mapCallDirectionToEnum(callDirection),
			metadata: JSON.parse(metadataStr),
		};

		logger.verbose("creating voice client with config: ", {
			appRef,
			callerNumber,
			ingressNumber,
			organizationId,
		});

		return new VoiceClientImpl({ ari, config, tts, stt });
	};
}

export { createCreateVoiceClient };
