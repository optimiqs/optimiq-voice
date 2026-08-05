import { ChannelVar } from "../types";

class ChannelVarNotFoundError extends Error {
  constructor(variable: ChannelVar) {
    super(`Channel variable not found: ${variable}`);
    this.name = this.constructor.name;
  }
}

export { ChannelVarNotFoundError };
