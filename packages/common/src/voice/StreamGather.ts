import { VerbRequest, VerbResponse } from "./Verb";

enum StreamGatherSource {
  SPEECH = "speech",
  DTMF = "dtmf",
  SPEECH_AND_DTMF = "speech,dtmf"
}

type StreamGatherOptions = {
  source?: StreamGatherSource;
};

type StartStreamGatherRequest = VerbRequest & StreamGatherOptions;

type StreamGatherPayload = VerbResponse & {
  speech?: string;
  digit?: string;
  responseTime: number;
};

export {
  StartStreamGatherRequest,
  StreamGatherOptions,
  StreamGatherPayload,
  StreamGatherSource
};
