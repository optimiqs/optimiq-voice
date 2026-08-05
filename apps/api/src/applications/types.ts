import { ApplicationType, CreateTestTokenResponse } from "@optimiq-voice/types";

type ApplicationData = {
  ref?: string;
  name: string;
  type: ApplicationType;
  endpoint: string;
  textToSpeech?: {
    create: {
      productRef: string;
      credentials?: string;
      config: unknown;
    };
  };
  speechToText?: {
    create: {
      productRef: string;
      credentials?: string;
      config: unknown;
    };
  };
  intelligence?: {
    create: {
      productRef: string;
      credentials?: string;
      config: unknown;
    };
  };
};

type TestTokenConfiguration = Omit<CreateTestTokenResponse, "token">;

export { ApplicationData, TestTokenConfiguration };
