import { VerbRequest } from "./Verb";

type StopSayRequest = VerbRequest;

type StopSayResponse = {
  mediaSessionRef: string;
};

export { StopSayRequest, StopSayResponse };
