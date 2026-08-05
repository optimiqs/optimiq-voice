import { VerbRequest } from "./Verb";

enum DialRecordDirection {
  IN = "IN",
  OUT = "OUT",
  BOTH = "BOTH"
}

enum DialStatus {
  TRYING = "TRYING",
  CANCEL = "CANCEL",
  ANSWER = "ANSWER",
  BUSY = "BUSY",
  PROGRESS = "PROGRESS",
  NOANSWER = "NOANSWER",
  // Maps from Asterisk's CHANUNAVAIL and CONGESTION
  FAILED = "FAILED"
}

type DialOptions = {
  timeout?: number;
  recordDirection?: DialRecordDirection;
};

type DialRequest = VerbRequest &
  DialOptions & {
    destination: string;
  };

export { DialOptions, DialRecordDirection, DialRequest, DialStatus };
