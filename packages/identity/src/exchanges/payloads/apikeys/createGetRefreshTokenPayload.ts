import { RefreshToken } from "@optimiq-voice/common";
import { Database } from "../../../db";
import { IdentityConfig } from "../../types";
import { buildRefreshTokenPayload } from "../buildRefreshTokenPayload";

function createGetRefreshTokenPayload(
  db: Database,
  identityConfig: IdentityConfig
) {
  return async function createGetRefreshTokenPayload(
    accessKeyId: string
  ): Promise<RefreshToken> {
    const apiKey = await db.apiKey.findFirst({
      where: {
        accessKeyId
      }
    });

    if (!apiKey) {
      return null;
    }

    const { ref: identityRef } = apiKey;

    return buildRefreshTokenPayload({
      identityConfig,
      accessKeyId,
      identityRef
    });
  };
}

export { createGetRefreshTokenPayload };
