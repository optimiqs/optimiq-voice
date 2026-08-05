import { v4 as uuidv4 } from "uuid";
import { STASIS_APP_NAME } from "@optimiq-voice/common";
import { API_HOST } from "../../envs";

function createExternalMediaConfig(port: number) {
  return {
    app: STASIS_APP_NAME,
    external_host: `${API_HOST}:${port}`,
    format: "slin16",
    transport: "tcp",
    data: uuidv4(),
    encapsulation: "audiosocket",
    variables: {
      FROM_EXTERNAL_MEDIA: "true"
    }
  };
}

export { createExternalMediaConfig };
