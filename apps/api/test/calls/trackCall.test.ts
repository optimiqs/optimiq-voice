import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { NatsConnection } from "nats";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
/* eslint-disable prettier/prettier */
import { DialStatus } from "@optimiq-voice/common";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@calls/trackCall", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should track the status of a call", async function () {
		const { createTrackCall } = await import("../../src/calls/createTrackCall");
		const callRef = "5d8c253a-62a0-48d5-9c8f-cfd00279936f";

		const call = {
			write: sandbox.stub(),
			end: sandbox.stub(),
			request: {
				ref: callRef,
			},
		};

		const subscription = { callback: sandbox.stub() };
		const nc = {
			subscribe: sandbox.stub().returns(subscription),
		} as unknown as NatsConnection;

		const trackCall = createTrackCall(nc);

		trackCall(call, () => {});

		const msg = {
			json: sandbox
				.stub()
				.onFirstCall()
				.returns({ ref: callRef, status: DialStatus.TRYING })
				.onSecondCall()
				.returns({ ref: callRef, status: DialStatus.PROGRESS })
				.onThirdCall()
				.returns({ ref: callRef, status: DialStatus.ANSWER }),
		};

		subscription.callback(null, msg);
		subscription.callback(null, msg);
		subscription.callback(null, msg);

		expect(call.write).to.have.been.calledWith({
			ref: callRef,
			status: DialStatus.TRYING,
		});
		expect(call.write).to.have.been.calledWith({
			ref: callRef,
			status: DialStatus.PROGRESS,
		});
		expect(call.write).to.have.been.calledWith({
			ref: callRef,
			status: DialStatus.ANSWER,
		});
	});
});
