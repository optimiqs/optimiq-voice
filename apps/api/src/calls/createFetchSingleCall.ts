import { flux } from "@influxdata/influxdb-client";
import {
	CALL_DETAIL_RECORD_MEASUREMENT,
	INFLUXDB_CALLS_BUCKET,
	InfluxDBClient,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { CallDetailRecord } from "@optimiq-voice/types";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function createFetchSingleCall(influxdb: InfluxDBClient) {
	/** See {@link import("./createFetchCalls").createFetchCalls} for why this takes a set. */
	return async (
		tenantIds: readonly (string | undefined)[],
		ref: string,
	): Promise<CallDetailRecord> => {
		const tenants = [...new Set(tenantIds.filter((id): id is string => Boolean(id)))];
		const query = flux`from(bucket: "${INFLUXDB_CALLS_BUCKET}")
      |> range(start: -365d)
      |> pivot(rowKey: ["callId"], columnKey: ["_field"], valueColumn: "_value")
      |> map(fn: (r) => ({
          r with
          duration: int(v: r.endedAt) - int(v: r.startedAt)
        }))
      |> filter(fn: (r) => r._measurement == "${CALL_DETAIL_RECORD_MEASUREMENT}")
      |> filter(fn: (r) => r.ref == ${ref} and contains(value: r.accessKeyId, set: ${tenants}))
      |> sort(columns: ["_time"], desc: true)
      |> limit(n: 1)`;

		logger.verbose("fetch single call request", { tenants, ref });

		const items = (await influxdb.collectRows(query)) as CallDetailRecord[];

		return items.length > 0 ? items[0] : null;
	};
}

export { createFetchSingleCall };
