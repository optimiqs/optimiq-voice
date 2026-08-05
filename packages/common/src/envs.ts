import { join } from "path";
import dotenv from "dotenv";

if (process.env.NODE_ENV === "development") {
  dotenv.config({ path: join(__dirname, "..", "..", "..", ".env") });
}

const e = process.env;

export const ROOT_DOMAIN =
  e.API_ROOT_DOMAIN || e.ROOT_DOMAIN || "optimiq-voice.local";
