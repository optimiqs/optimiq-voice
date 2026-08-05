type LinkTwilioNumberToApplicationParams = {
  phoneNumber: string;
  accessKeyId: string;
  aclEntries: string[];
  originationUriBase: string;
  applicationRef: string;
  friendlyName?: string;
};

type TwilioTrunkParams = {
  resourceRef: string;
  originationUriBase: string;
  aclEntries: string[];
};

type AppConfig = {
  testCases?: unknown;
  intelligence: {
    config: {
      languageModel: {
        apiKey?: string;
      };
    };
  };
};

export { LinkTwilioNumberToApplicationParams, TwilioTrunkParams, AppConfig };
