import { connect } from "nats";
import { getLogger } from "@optimiq-voice/logger";
import { NatsEventCallback } from "./types";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

const ROUTR_CALL_SUBJECT = "routr.call.*";

async function streamEvents(subscription, callback: NatsEventCallback) {
	// eslint-disable-next-line no-loops/no-loops
	for await (const m of subscription) {
		const messageStr = m.data.toString();
		callback({ ...JSON.parse(messageStr) });
	}
}

/**
 * This method listens for registration events from Routr.
 *
 * @param {string} natsUrl - The NATS server URL
 * @param {RegisterEventCallback} callback - The callback function
 * @return {void}
 */
async function watchNats(natsUrl: string, callback: NatsEventCallback) {
	const connection = await connect({
		servers: natsUrl,
		maxReconnectAttempts: -1,
	});
	const subscription = connection.subscribe(ROUTR_CALL_SUBJECT);

	logger.verbose("connected to nats", { natsUrl });
	logger.verbose("subscribed to subjects", {
		subjects: [ROUTR_CALL_SUBJECT],
	});

	void streamEvents(subscription, callback).catch((error) => {
		logger.error("NATS event stream failed", error);
	});

	return {
		close: async () => {
			subscription.unsubscribe();
			await connection.drain();
		},
	};
}

export { watchNats };
