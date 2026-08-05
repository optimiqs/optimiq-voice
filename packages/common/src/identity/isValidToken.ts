import jwt from "jsonwebtoken";
import { getLogger } from "@optimiq-voice/logger";
import { JsonWebErrorEnum } from "./types";

const logger = getLogger({ service: "identity", filePath: __filename });

function isValidToken(token: string, secret: string): boolean {
  try {
    const decoded = jwt.verify(token, secret) as { exp: number };
    const currentTime = Math.floor(Date.now() / 1000);

    if (decoded.exp <= currentTime) {
      logger.verbose("token expired", { exp: decoded.exp, currentTime });
      return false;
    }

    return true;
  } catch (error) {
    if (error.name === JsonWebErrorEnum.JsonWebTokenError) {
      logger.verbose("invalid JWT token", { token });
    } else if (error.name === JsonWebErrorEnum.TokenExpiredError) {
      logger.verbose("token expired", { token });
    } else {
      logger.verbose("unexpected JWT error:", error);
    }

    return false;
  }
}

export { isValidToken };
