import { homedir } from "os";
import { join } from "path";

export const BASE_DIR = join(homedir(), ".optimiq-voice");
export const CONFIG_FILE = join(homedir(), ".optimiq-voice", "config.json");
export const OPTIMIQ_VOICE_ACCESS_CONTROL_LIST = ["165.22.7.155/32"]; // TODO: We will need to allow passing this as a parameter
export const OPTIMIQ_VOICE_ORIGINATION_URI_BASE = "pstn.optimiq.health";
export const TWILIO_PSTN_URI_BASE = "pstn.twilio.com";
export const WORKSPACE_ENDPOINT = "api.optimiq.health";
