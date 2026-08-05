import { VerbRequest, VerbResponse } from "./Verb";

enum GatherSource {
  SPEECH = "speech",
  DTMF = "dtmf",
  SPEECH_AND_DTMF = "speech,dtmf"
}

type GatherOptions = {
  finishOnKey?: string;
  maxDigits?: number;
  timeout?: number;
  source?: GatherSource;
};

type GatherRequest = VerbRequest & GatherOptions;

type GatherResponse = VerbResponse & {
  speech?: string;
  digits?: string;
  responseTime: number;
};

export { GatherOptions, GatherRequest, GatherResponse, GatherSource };
