import { VerbRequest, VerbResponse } from "./Verb";

enum StreamDirection {
  IN = "IN",
  OUT = "OUT",
  BOTH = "BOTH"
}

enum StreamAudioFormat {
  WAV = "WAV"
}

enum StreamMessageType {
  AUDIO_IN = "AUDIO_IN",
  AUDIO_OUT = "AUDIO_OUT",
  ERROR = "ERROR"
}

type StreamOptions = {
  direction?: StreamDirection;
  format?: StreamAudioFormat;
};

type StartStreamRequest = VerbRequest & StreamOptions;

type StartStreamResponse = VerbResponse & {
  streamRef: string;
};

type StopStreamRequest = VerbRequest & {
  streamRef: string;
};

type StreamPayload = {
  mediaSessionRef: string;
  streamRef: string;
  format: StreamAudioFormat;
  type: StreamMessageType;
  data?: Uint8Array;
  code?: string;
  message?: string;
};

export {
  StartStreamRequest,
  StartStreamResponse,
  StopStreamRequest,
  StreamAudioFormat,
  StreamDirection,
  StreamMessageType,
  StreamOptions,
  StreamPayload
};
