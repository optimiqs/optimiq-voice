import { flux } from "@influxdata/influxdb-client";
import {
	CALL_DETAIL_RECORD_MEASUREMENT,
	INFLUXDB_CALLS_BUCKET,
	InfluxDBClient,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { CallDetailRecord, ListCallsRequest, ListCallsResponse } from "@optimiq-voice/types";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function createFetchCalls(influxdb: InfluxDBClient) {
	/**
	 * `tenantIds` is the organization id plus, when the tenant had one, the legacy `WO…` key.
	 *
	 * The CDR measurement's `accessKeyId` tag has carried the organization id since Step 4 flipped
	 * the per-call minter, but points written before that carry the workspace key. Filtering on
	 * both is what makes "the same rows before and after" true for a tenant whose history spans
	 * the cutover; InfluxDB is a time-series store, not one of the telephony tables Step 5 item 1
	 * rewrites, so there is nothing to backfill there.
	 */
	return async (
		tenantIds: readonly (string | undefined)[],
		request: ListCallsRequest,
	): Promise<ListCallsResponse> => {
		const { after, before, type, from, to, status, pageSize, pageToken } = request;

		const tenants = [...new Set(tenantIds.filter((id): id is string => Boolean(id)))];
		const accessKeyIdFilter = tenants.length
			? flux`and contains(value: r.accessKeyId, set: ${tenants})`
			: flux``;
		const typeFilter = type ? flux`and r.type == "${type}"` : flux``;
		const fromFilter = from ? flux`and r.from == "${from}"` : flux``;
		const toFilter = to ? flux`and r.to == "${to}"` : flux``;
		const statusFilter = status ? flux`and r.status == "${status}"` : flux``;
		const pageTokenFilter = pageToken
			? flux`|> filter(fn: (r) => r.startedAtParsed < int(v: ${pageToken}))`
			: flux``;
		const limit = flux`|> limit(n: ${pageSize || 50})`;
		const parsedAfter = after ? Math.trunc(new Date(after).getTime() / 1000) : flux`-30d`;
		const parsedBefore = before ? new Date(before).getTime() / 1000 : new Date().getTime() / 1000;

		const query = flux`from(bucket: "${INFLUXDB_CALLS_BUCKET}")
      |> range(start: ${parsedAfter})
      |> pivot(rowKey: ["callId"], columnKey: ["_field"], valueColumn: "_value")
      |> map(fn: (r) => ({
          r with
          duration: int(v: r.endedAt) - int(v: r.startedAt),
          startedAtParsed: int(v: r.startedAt) / 1000,
        }))
      |> filter(fn: (r) =>
        r._measurement == "${CALL_DETAIL_RECORD_MEASUREMENT}"
        and r.startedAtParsed < ${parsedBefore}
        ${accessKeyIdFilter}
        ${typeFilter}
        ${fromFilter}
        ${toFilter}
        ${statusFilter})
      |> group()
      |> sort(columns: ["startedAtParsed"], desc: true)
      ${pageTokenFilter}
      ${limit}`;

		logger.verbose("list calls request", {
			tenants,
			after,
			before,
			query: query.toString(),
		});

		const items = (await influxdb.collectRows(query)) as CallDetailRecord[];

		const nextPageToken = items.length > 0 ? items[items.length - 1].startedAt : "";

		return {
			nextPageToken: nextPageToken + "",
			items,
		};
	};
}

export { createFetchCalls };
