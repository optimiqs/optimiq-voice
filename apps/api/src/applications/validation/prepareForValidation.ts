import { struct } from "pb-util";
import {
  Application,
  ApplicationType,
  CreateApplicationRequest,
  UpdateApplicationRequest
} from "@optimiq-voice/types";

function prepareForValidation(
  request: CreateApplicationRequest | UpdateApplicationRequest
) {
  const type = request.type || ApplicationType.EXTERNAL;

  const result = {
    ref: (request as UpdateApplicationRequest).ref, // Only for UpdateApplicationRequest
    name: request.name,
    type,
    endpoint: request.endpoint
  } as Application;

  const createProperty = (property) => {
    return property
      ? {
          productRef: property.productRef,
          credentials: property.credentials
            ? struct.decode(property.credentials)
            : undefined,
          config: property.config ? struct.decode(property.config) : null
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

export { prepareForValidation };
