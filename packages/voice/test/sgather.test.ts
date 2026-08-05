import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox, match } from "sinon";
import sinonChai from "sinon-chai";
import { StartStreamGatherRequest, StreamGatherSource } from "@optimiq-voice/common";
import { getVoiceObject, mediaSessionRef, voiceRequest } from "./helpers";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@voice/verbs/SGather", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should create an transcription stream", async function () {
		// Arrange
		const { StartStreamGather } = await import("../src/verbs/StreamGather");

		const voice = getVoiceObject(sandbox, "startStreamGatherResponse");

		const startStreamGather = new StartStreamGather(voiceRequest, voice);

		const startStreamGatherRequest: StartStreamGatherRequest = {
			mediaSessionRef,
			source: StreamGatherSource.SPEECH,
		};

		// Act
		await startStreamGather.run(startStreamGatherRequest);

		// Assert
		expect(voice.removeListener).to.have.been.calledOnce;
		expect(voice.on).to.have.been.calledOnce;
		expect(voice.on).to.have.been.calledWith("data", match.func);
		expect(voice.write).to.have.been.calledOnce;
		expect(voice.write).to.have.been.calledWith({
			startStreamGatherRequest,
		});
	});

	it("should stream transcriptions from the server", async function () {
		// Arrange
		const { VoiceResponse } = await import("../src/VoiceResponse");

		const onStub = sandbox
			.stub()
			.onFirstCall()
			.callsFake((_, cb) => {
				cb({ content: "startStreamGatherResponse" });
			});

		const voice = {
			removeListener: sandbox.stub(),
			on: onStub,
			once: sandbox.stub(),
			write: sandbox.stub(),
			end: sandbox.stub(),
		};
		const voiceResponse = new VoiceResponse(voiceRequest, voice);

		const dummyCallback = sandbox.stub();

		// Act
		const sGather = await voiceResponse.sgather({
			source: StreamGatherSource.SPEECH,
		});

		// This will be called twice
		sGather.onPayload(dummyCallback);

		// First payload in
		voice.on.yield({
			streamGatherPayload: {
				data: { speech: "Hi there!" },
			},
		});

		// Second payload in
		voice.on.yield({
			streamGatherPayload: {
				data: { speech: "How are you?" },
			},
		});

		// Assert
		expect(dummyCallback).to.have.been.calledTwice;

		expect(dummyCallback).to.have.been.calledWith({
			data: { speech: "Hi there!" },
		});

		expect(dummyCallback).to.have.been.calledWith({
			data: { speech: "How are you?" },
		});
	});
});
