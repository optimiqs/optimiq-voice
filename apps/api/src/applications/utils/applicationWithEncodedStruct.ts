import { struct } from "pb-util";
import { datesMapper } from "@optimiq-voice/common";
import { AUTOPILOT_SPECIAL_LOCAL_ADDRESS } from "@optimiq-voice/common";
import { Application, ApplicationType } from "@optimiq-voice/types";

function applicationWithEncodedStruct(application): Application {
  const encodeConfig = (property) => {
    return property?.config ? struct.encode(property.config) : null;
  };

  const result = { ...application };

  // Hide the default endpoint value for AUTOPILOT applications
  if (
    application.type === ApplicationType.AUTOPILOT &&
    application.endpoint === AUTOPILOT_SPECIAL_LOCAL_ADDRESS
  ) {
    result.endpoint = "";
  }

  if (application.textToSpeech) {
    delete application.textToSpeech.credentials;
    result.textToSpeech = {
      ...application.textToSpeech,
      config: encodeConfig(application.textToSpeech)
    };
  }

  if (application.speechToText) {
    delete application.speechToText.credentials;
    result.speechToText = {
      ...application.speechToText,
      config: encodeConfig(application.speechToText)
    };
  }

  if (application.intelligence) {
    const intelligenceCopy = application.intelligence;
    delete intelligenceCopy.credentials;

    result.intelligence = {
      ...intelligenceCopy,
      config: encodeConfig(intelligenceCopy)
    };
  }

  return datesMapper(result);
}

export { applicationWithEncodedStruct };
