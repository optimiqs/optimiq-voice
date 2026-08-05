import { ParameterizedQuery } from "@influxdata/influxdb-client";

type InfluxDBClient = {
	collectRows(query: ParameterizedQuery): Promise<unknown[]>;
};

export { InfluxDBClient };
