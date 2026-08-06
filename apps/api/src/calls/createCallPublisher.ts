import { connect } from "nats";
import { getLogger } from "@optimiq-voice/logger";
import { CALLS_CREATE_SUBJECT, NATS_CREDENTIALS } from "../envs";
import { CreateCallRequest } from "./types";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

async function createCallPublisher(natsUrl: string) {
	logger.verbose("connecting to nats", { natsUrl });

	const nc = await connect({ servers: natsUrl, ...NATS_CREDENTIALS, maxReconnectAttempts: -1 });

	return {
		publishCall: async (request: CreateCallRequest & { ref: string }) => {
			logger.verbose("publishing call", { ref: request.ref });

			nc.publish(CALLS_CREATE_SUBJECT, JSON.stringify(request));
		},
	};
}

export { createCallPublisher };
