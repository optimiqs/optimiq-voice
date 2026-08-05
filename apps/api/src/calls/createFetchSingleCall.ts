import { flux } from "@influxdata/influxdb-client";
import {
  CALL_DETAIL_RECORD_MEASUREMENT,
  INFLUXDB_CALLS_BUCKET,
  InfluxDBClient
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { CallDetailRecord } from "@optimiq-voice/types";

const logger = getLogger({ service: "api", filePath: __filename });

function createFetchSingleCall(influxdb: InfluxDBClient) {
  return async (
    accessKeyId: string,
    ref: string
  ): Promise<CallDetailRecord> => {
    const query = flux`from(bucket: "${INFLUXDB_CALLS_BUCKET}")
      |> range(start: -365d)
      |> pivot(rowKey: ["callId"], columnKey: ["_field"], valueColumn: "_value")
      |> map(fn: (r) => ({
          r with
          duration: int(v: r.endedAt) - int(v: r.startedAt)
        }))
      |> filter(fn: (r) => r._measurement == "${CALL_DETAIL_RECORD_MEASUREMENT}")
      |> filter(fn: (r) => r.ref == ${ref} and r.accessKeyId == "${accessKeyId}")
      |> sort(columns: ["_time"], desc: true)
      |> limit(n: 1)`;

    logger.verbose("fetch single call request", { accessKeyId, ref });

    const items = (await influxdb.collectRows(query)) as CallDetailRecord[];

    return items.length > 0 ? items[0] : null;
  };
}

export { createFetchSingleCall };
