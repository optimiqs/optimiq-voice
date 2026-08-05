import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox, match } from "sinon";
import sinonChai from "sinon-chai";
import { PlayRequest } from "@optimiq-voice/common";
import { getVoiceObject, mediaSessionRef, voiceRequest } from "./helpers";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@voice/verbs/play", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should play an audio", async function () {
		// Arrange
		const { Play } = await import("../src/verbs");

		const voice = getVoiceObject(sandbox, "playResponse");

		const play = new Play(voiceRequest, voice);

		const playRequest: PlayRequest = {
			mediaSessionRef,
			url: "http://example.com/audio.mp3",
		};

		// Act
		await play.run(playRequest);

		// Assert
		expect(voice.removeListener).to.have.been.calledOnce;
		expect(voice.on).to.have.been.calledOnce;
		expect(voice.on).to.have.been.calledWith("data", match.func);
		expect(voice.write).to.have.been.calledOnce;
		expect(voice.write).to.have.been.calledWith({
			playRequest,
		});
	});

	it("should throw an error if the request is invalid", async function () {
		// Arrange
		const { Play } = await import("../src/verbs");

		const voice = getVoiceObject(sandbox, "playResponse");

		const play = new Play(voiceRequest, voice);

		// Act
		const promise = play.run({ invalid: "data" } as unknown as PlayRequest);

		// Assert
		// eslint-disable-next-line prettier/prettier
		return expect(promise).to.be.rejectedWith('Required at "url"');
	});
});
