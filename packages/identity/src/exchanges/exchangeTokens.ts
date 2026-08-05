import jwt from "jsonwebtoken";
import { Database } from "../db";
import * as AK from "./payloads/apikeys";
import * as US from "./payloads/users";
import { IdentityConfig } from "./types";

const SIGN_ALGORITHM = "RS256";

// prettier-ignore
function exchangeTokens(db: Database, identityConfig: IdentityConfig) {
  return async (accessKeyId: string) => {
    const { privateKey, idTokenExpiresIn, accessTokenExpiresIn, refreshTokenExpiresIn } = identityConfig;

    const idTokenSignOptions = { algorithm: SIGN_ALGORITHM, expiresIn: idTokenExpiresIn } as jwt.SignOptions;
    const accessTokenSignOptions = { algorithm: SIGN_ALGORITHM, expiresIn: accessTokenExpiresIn } as jwt.SignOptions;
    const refreshTokenSignOptions = { algorithm: SIGN_ALGORITHM, expiresIn: refreshTokenExpiresIn } as jwt.SignOptions;

    let idToken = null;
    let accessToken = null;
    let refreshToken = null;

    if (accessKeyId.startsWith("US")) {
      const idTokenPayload = await US.createGetIdTokenPayload(db, identityConfig)(accessKeyId);
      const accessTokenPayload = await US.createGetAccessTokenPayload(db, identityConfig)(accessKeyId);
      const refreshTokenPayload = await US.createGetRefreshTokenPayload(db, identityConfig)(accessKeyId);

      idToken = jwt.sign(idTokenPayload, privateKey, idTokenSignOptions);
      accessToken = jwt.sign(accessTokenPayload, privateKey, accessTokenSignOptions);
      refreshToken = jwt.sign(refreshTokenPayload, privateKey, refreshTokenSignOptions);
    } else {
      const accessTokenPayload = await AK.createGetAccessTokenPayload(db, identityConfig)(accessKeyId);
      const refreshTokenPayload = await AK.createGetRefreshTokenPayload(db, identityConfig)(accessKeyId);

      accessToken = jwt.sign(accessTokenPayload, privateKey, accessTokenSignOptions);
      refreshToken = jwt.sign(refreshTokenPayload, privateKey, refreshTokenSignOptions);
    }

    return {
      idToken,
      accessToken,
      refreshToken
    };
  }
}

export { exchangeTokens };
