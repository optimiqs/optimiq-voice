import { AccessToken, TokenUseEnum } from "@optimiq-voice/common/";
import { Database } from "../../../db";
import { IdentityConfig } from "../../types";

function createGetAccessTokenPayload(
  db: Database,
  identityConfig: IdentityConfig
) {
  return async function getAccessTokenPayload(
    accessKeyId: string
  ): Promise<AccessToken> {
    const apiKey = await db.apiKey.findFirst({
      where: {
        accessKeyId
      },
      include: {
        workspace: true
      }
    });

    if (!apiKey) {
      return null;
    }

    const { issuer, audience } = identityConfig;
    const { ref, workspace } = apiKey;

    const access = [
      {
        accessKeyId: workspace.accessKeyId,
        role: apiKey.role
      }
    ];

    return {
      iss: issuer,
      sub: ref,
      aud: audience,
      tokenUse: TokenUseEnum.ACCESS,
      accessKeyId,
      access
    } as AccessToken;
  };
}

export { createGetAccessTokenPayload };
