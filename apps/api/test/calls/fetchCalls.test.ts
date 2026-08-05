import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { InfluxDBClient } from "@optimiq-voice/common";
/* eslint-disable prettier/prettier */
import { CallType, CallStatus } from "@optimiq-voice/types";
import { TEST_ACCESS_KEY_ID, TEST_ORGANIZATION_ID } from "../utils";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@calls/fetchCalls", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should fetch calls from influxdb with no filters", async function () {
		// Arrange
		const { createFetchCalls } = await import("../../src/calls/createFetchCalls");
		const accessKeyId = TEST_ORGANIZATION_ID;
		const items = [
			{
				ref: "01",
				startedAt: 1715869342759,
				endedAt: 1715869342759,
				from: "+1234567890",
				to: "+1234567891",
				status: CallStatus.NORMAL_CLEARING,
				type: CallType.API_ORIGINATED,
				accessKeyId,
			},
		];

		const influxdb = {
			collectRows: sandbox.stub().resolves(items),
		} as InfluxDBClient;

		const fetchCalls = createFetchCalls(influxdb);

		// Act
		// The CDR tag is filtered against the *set* of tenant ids — the organization id plus, for a
		// tenant whose history predates the cutover, its legacy `WO…` key.
		const result = await fetchCalls([accessKeyId], {});

		// Assert
		expect(result).to.deep.equal({
			nextPageToken: "1715869342759",
			items,
		});
	});

	it("should fetch calls from influxdb with filters", async function () {
		// Arrange
		const { createFetchCalls } = await import("../../src/calls/createFetchCalls");
		const accessKeyId = TEST_ORGANIZATION_ID;
		const type = CallType.API_ORIGINATED;
		const from = "+1234567890";
		const to = "+1234567891";
		const status = CallStatus.NORMAL_CLEARING;
		const items = [
			{
				ref: "01",
				callId: "asdf",
				startedAt: 1715869342759,
				endedAt: 1715869342759,
				from,
				to,
				status,
				accessKeyId,
				type,
			},
		];

		// Arrange
		const collectRows = sandbox.stub().resolves(items);
		const influxdb = {
			collectRows,
		} as InfluxDBClient;

		const fetchCalls = createFetchCalls(influxdb);

		// Act
		await fetchCalls([accessKeyId, TEST_ACCESS_KEY_ID], {
			after: "2024-01-01T00:00:00.000Z",
			before: "2024-01-02T23:00:00.000Z",
			type,
			from,
			to,
			status,
		});

		// Assert
		const queryStr = collectRows.getCall(0).args[0].toString();
		expect(queryStr).to.include('from(bucket: "calls")');
		// expect(queryStr).to.include("range(start: 2024-01-01T00:00:00.000Z, stop: 2024-01-02T23:00:00.000Z)");
		expect(queryStr).to.include(
			'pivot(rowKey: ["callId"], columnKey: ["_field"], valueColumn: "_value")',
		);
		expect(queryStr).to.include("duration: int(v: r.endedAt) - int(v: r.startedAt),");
		expect(queryStr).to.include('r._measurement == "cdr"');
		expect(queryStr).to.include("group()");
		expect(queryStr).to.include('sort(columns: ["startedAtParsed"], desc: true)');
		expect(queryStr).to.include("limit(n: 50)");
		expect(queryStr).to.include(
			`and contains(value: r.accessKeyId, set: ["${accessKeyId}","${TEST_ACCESS_KEY_ID}"])`,
		);
		expect(queryStr).to.include(`and r.type == "${type}"`);
		expect(queryStr).to.include(`and r.from == "${from}"`);
		expect(queryStr).to.include(`and r.to == "${to}"`);
		expect(queryStr).to.include(`and r.status == "${status}"`);
	});
});
