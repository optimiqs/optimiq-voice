import jwt from "jsonwebtoken";
import { SIGN_ALGORITHM } from "../constants";
import { IdentityConfig } from "../exchanges/types";

function createGenerateWorkspaceInviteToken(identityConfig: IdentityConfig) {
  return async function generateWorkspaceInviteToken(params: {
    userRef: string;
    memberRef: string;
    accessKeyId: string;
    expiresIn?: string;
  }): Promise<string> {
    const { privateKey } = identityConfig;
    const { issuer, audience } = identityConfig;
    const { userRef, memberRef, accessKeyId, expiresIn } = params;

    const accessTokenSignOptions = {
      algorithm: SIGN_ALGORITHM,
      expiresIn: expiresIn || "1d"
    } as jwt.SignOptions;

    const unsignedToken = {
      iss: issuer,
      sub: userRef,
      aud: audience,
      memberRef: memberRef,
      accessKeyId
    };

    return jwt.sign(unsignedToken, privateKey, accessTokenSignOptions);
  };
}

export { createGenerateWorkspaceInviteToken };
