import { Channel } from "ari-client";
import { ChannelVarNotFoundError } from "../errors/ChannelVarNotFoundError";
import { ChannelVar } from "../types";

function createGetChannelVar(channel: Channel) {
	return async function getChannelVar(variable: ChannelVar) {
		try {
			return await channel.getChannelVar({
				variable,
			});
		} catch (e) {
			throw new ChannelVarNotFoundError(variable);
		}
	};
}

export { createGetChannelVar };
