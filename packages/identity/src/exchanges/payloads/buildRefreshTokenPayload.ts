import { RefreshToken, TokenUseEnum } from "@optimiq-voice/common";
import { IdentityConfig } from "../types";

function buildRefreshTokenPayload(params: {
  identityConfig: IdentityConfig;
  accessKeyId: string;
  identityRef: string;
}) {
  const { identityConfig, accessKeyId, identityRef } = params;
  const { issuer, audience } = identityConfig;

  return {
    iss: issuer,
    sub: identityRef,
    aud: audience,
    tokenUse: TokenUseEnum.REFRESH,
    accessKeyId
  } as RefreshToken;
}

export { buildRefreshTokenPayload };
