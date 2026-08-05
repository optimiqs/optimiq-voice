import { InfluxDB } from "@influxdata/influxdb-client";
import { INFLUXDB_ORG, INFLUXDB_TOKEN, INFLUXDB_URL } from "../envs";

const client = new InfluxDB({
	url: INFLUXDB_URL,
	token: INFLUXDB_TOKEN,
});

const influxdb = client.getQueryApi(INFLUXDB_ORG);

export { influxdb };
