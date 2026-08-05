import { decodeToken, TokenUseEnum } from "@optimiq-voice/common";

function getAccessKeyIdFromToken(token: string): string {
  const decodedToken = decodeToken<TokenUseEnum.ACCESS>(token);

  if (decodedToken.tokenUse !== TokenUseEnum.ACCESS) {
    throw new Error("Invalid token type");
  }

  return decodedToken.accessKeyId;
}

export { getAccessKeyIdFromToken };
