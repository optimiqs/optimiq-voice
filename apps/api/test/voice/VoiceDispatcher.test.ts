import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { NatsConnection } from "nats";
import { createSandbox, match } from "sinon";
import sinonChai from "sinon-chai";
import { AriEvent } from "../../src/voice/types";
import { getAriStub } from "./helper";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@voice/handler/VoiceDispatcher", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should create a VoiceDispatcher", async function () {
		// Arrange
		const { VoiceDispatcher } = await import("../../src/voice/VoiceDispatcher");
		const ari = getAriStub(sandbox);
		const nc = {} as unknown as NatsConnection;
		const createVoiceClient = sandbox.stub();
		const voiceDispatcher = new VoiceDispatcher(ari, nc, createVoiceClient);

		// Act
		voiceDispatcher.start();

		// Assert
		expect(ari.on).to.have.been.called.calledThrice;
		expect(ari.on).to.have.been.calledWith(
			AriEvent.STASIS_START,
			match.func.and(
				match(function (fn) {
					return fn.name === "bound handleStasisStart";
				}),
			),
		);
		expect(ari.on).to.have.been.calledWith(
			AriEvent.STASIS_END,
			match.func.and(
				match(function (fn) {
					return fn.name === "bound handleStasisEnd";
				}),
			),
		);
	});
});
