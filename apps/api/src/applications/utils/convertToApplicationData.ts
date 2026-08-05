import { struct } from "pb-util";
import {
  ApplicationType,
  CreateApplicationRequest,
  UpdateApplicationRequest
} from "@optimiq-voice/types";
import { ApplicationData } from "../types";

function convertToApplicationData(
  request: CreateApplicationRequest | UpdateApplicationRequest
): ApplicationData {
  const type = request.type || ApplicationType.EXTERNAL;

  const result = {
    ref: (request as UpdateApplicationRequest).ref, // Only for UpdateApplicationRequest
    name: request.name,
    type,
    endpoint: request.endpoint
  } as unknown as ApplicationData;

  const createProperty = (property) => {
    return property
      ? {
          create: {
            productRef: property.productRef,
            credentials: property.credentials
              ? JSON.stringify(struct.decode(property.credentials))
              : undefined,
            config: property.config ? struct.decode(property.config) : null
          }
        }
      : undefined;
  };

  if (request.textToSpeech) {
    result.textToSpeech = createProperty(request.textToSpeech);
  }

  if (request.speechToText) {
    result.speechToText = createProperty(request.speechToText);
  }

  if (request.intelligence) {
    result.intelligence = createProperty(request.intelligence);
  }

  return result;
}

export { convertToApplicationData };
