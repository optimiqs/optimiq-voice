import { VerbRequest } from "./Verb";

enum RecordFormat {
  WAV = "wav"
}

type RecordOptions = {
  maxDuration?: number;
  maxSilence?: number;
  beep?: boolean;
  finishOnKey?: string;
};

type RecordRequest = VerbRequest & RecordOptions;

type RecordResponse = {
  mediaSessionRef: string;
  name: string;
  duration: number;
  format: RecordFormat;
};

export { RecordFormat, RecordOptions, RecordRequest, RecordResponse };
