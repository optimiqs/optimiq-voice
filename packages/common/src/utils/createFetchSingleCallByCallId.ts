import { flux } from "@influxdata/influxdb-client";
import { CallDetailRecord } from "@optimiq-voice/types";
import {
  CALL_DETAIL_RECORD_MEASUREMENT,
  INFLUXDB_CALLS_BUCKET
} from "../constants";
import { InfluxDBClient } from "./types";

function createFetchSingleCallByCallId(influxdb: InfluxDBClient) {
  return async function fetchSingleCallByCallId(
    callId: string
  ): Promise<CallDetailRecord> {
    const query = flux`from(bucket: "${INFLUXDB_CALLS_BUCKET}")
      |> range(start: -365d)
      |> pivot(rowKey: ["callId"], columnKey: ["_field"], valueColumn: "_value")
      |> map(fn: (r) => ({
          r with
          duration: int(v: r.endedAt) - int(v: r.startedAt)
        }))
      |> filter(fn: (r) => r._measurement == "${CALL_DETAIL_RECORD_MEASUREMENT}")
      |> filter(fn: (r) => r.callId == ${callId})
      |> sort(columns: ["_time"], desc: true)
      |> limit(n: 1)`;

    const items = (await influxdb.collectRows(query)) as CallDetailRecord[];

    return items.length > 0 ? items[0] : null;
  };
}

export { createFetchSingleCallByCallId };
