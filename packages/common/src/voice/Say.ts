import { Struct } from "pb-util";
import { VerbRequest } from "./Verb";

type SayRequest = VerbRequest & {
  text: string;
  options?: Struct;
};

type SayOptions = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

export { SayOptions, SayRequest };
