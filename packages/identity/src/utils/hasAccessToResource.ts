import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
  Access,
  decodeToken,
  getTokenFromCall,
  TokenUseEnum
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { JsonObject } from "../db/schema";

const logger = getLogger({ service: "sipnet", filePath: __filename });

async function hasAccessToResource(
  call: unknown,
  getFn: (ref: string) => Promise<{ extended?: JsonObject }>
) {
  const { request } = call as { request: { ref: string } };
  const { extended } = await getFn(request.ref);

  logger.verbose("call to hasAccessToResource", {
    ref: request.ref,
    accessKeyId: extended?.accessKeyId
  });

  // If the resource doesn't exist, allow the operation
  if (!extended) return true;

  const token = getTokenFromCall(call as ServerInterceptingCall);
  const decodedToken = decodeToken<TokenUseEnum.ACCESS>(token);
  const accessKeyIds = decodedToken.access?.map((a: Access) => a.accessKeyId);

  return accessKeyIds.includes(extended?.accessKeyId as string);
}

export { hasAccessToResource };
