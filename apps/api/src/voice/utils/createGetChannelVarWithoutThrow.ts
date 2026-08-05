import { Channel } from "ari-client";
import { ChannelVar } from "../types";

function createGetChannelVarWithoutThrow(channel: Channel) {
  return async function getChannelVarWithoutThrow(variable: ChannelVar) {
    try {
      return await channel.getChannelVar({
        variable
      });
    } catch (e) {
      return null;
    }
  };
}

export { createGetChannelVarWithoutThrow };
