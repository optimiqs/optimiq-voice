import { VerbRequest } from "./Verb";

type MuteOptions = {
  direction?: MuteDirection;
};

enum MuteDirection {
  IN = "IN",
  OUT = "OUT",
  BOTH = "BOTH"
}

type MuteRequest = VerbRequest & { direction: MuteDirection };

export { MuteDirection, MuteOptions, MuteRequest };
