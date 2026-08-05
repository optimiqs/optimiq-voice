import { connect } from "nats";
import { InfluxDBClient } from "@optimiq-voice/common";
import { db } from "../core/db";
import { NATS_URL } from "../envs";
import { createCall } from "./createCall";
import { createCallPublisher } from "./createCallPublisher";
import { createTrackCall } from "./createTrackCall";
import { getCall } from "./getCall";
import { listCalls } from "./listCalls";

async function buildService(influxdb: InfluxDBClient) {
	const callPublisher = await createCallPublisher(NATS_URL);
	const nc = await connect({ servers: NATS_URL, maxReconnectAttempts: -1 });

	return {
		definition: {
			serviceName: "Calls",
			pckg: "calls",
			version: "v1beta2",
			proto: "calls.proto",
		},
		handlers: {
			createCall: createCall(db, callPublisher),
			listCalls: listCalls(influxdb),
			getCall: getCall(influxdb),
			trackCall: createTrackCall(nc),
		},
	};
}

export { buildService };
