import { Channel, Client, StasisStart } from "ari-client";
import { v4 as uuidv4 } from "uuid";
import { createGenerateCallAccessToken } from "@optimiq-voice/identity";
import { getLogger } from "@optimiq-voice/logger";
import { identityConfig } from "../core/identityConfig";
import { mapCallDirectionToEnum } from "../events/mapCallDirectionToEnum";
import { VoiceClientImpl } from "./client";
import { CreateContainer } from "./integrations/types";
import { ChannelVar, VoiceClient } from "./types";
import { createGetChannelVarWithoutThrow } from "./utils/createGetChannelVarWithoutThrow";

const logger = getLogger({ service: "api", filePath: __filename });

const generateCallAccessToken = createGenerateCallAccessToken(identityConfig);

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
    const callDirection = (await getChannelVar(ChannelVar.CALL_DIRECTION))
      ?.value;
    const appRef = (await getChannelVar(ChannelVar.APP_REF))?.value;
    const ingressNumber =
      (await getChannelVar(ChannelVar.INGRESS_NUMBER))?.value || "";

    // Try to get callRef from channel variable (set by dialplan from X-Call-Ref header for API-originated calls)
    // If not found, generate a new UUID (for PSTN-terminated calls)
    const callRefFromChannel = (await getChannelVar(ChannelVar.CALL_REF))
      ?.value;
    const callRef = callRefFromChannel || uuidv4();

    const { accessKeyId, endpoint, tts, stt } = await createContainer(appRef);

    const sessionToken = await generateCallAccessToken({ accessKeyId, appRef });

    const metadataStr =
      (await getChannelVar(ChannelVar.METADATA))?.value ?? "{}";

    const config = {
      appRef,
      mediaSessionRef,
      callRef,
      accessKeyId,
      endpoint,
      callerName,
      callerNumber,
      ingressNumber,
      sessionToken,
      callDirection: mapCallDirectionToEnum(callDirection),
      metadata: JSON.parse(metadataStr)
    };

    logger.verbose("creating voice client with config: ", {
      appRef,
      callerNumber,
      ingressNumber
    });

    return new VoiceClientImpl({ ari, config, tts, stt });
  };
}

export { createCreateVoiceClient };
