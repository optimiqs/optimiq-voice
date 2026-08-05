import {
  CreateApplicationRequest,
  UpdateApplicationRequest
} from "@optimiq-voice/types";
import { createValidationSchema } from "./createValidationSchema";
import { prepareForValidation } from "./prepareForValidation";

function validOrThrow(
  request: CreateApplicationRequest | UpdateApplicationRequest
) {
  const data = prepareForValidation(request);

  const schema = createValidationSchema({
    applicationType: request.type,
    ttsEngineName: request.textToSpeech?.productRef,
    sttEngineName: request.speechToText?.productRef
  });

  schema.parse(data);
}

export { validOrThrow };
