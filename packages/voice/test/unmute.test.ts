import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox, match } from "sinon";
import sinonChai from "sinon-chai";
import { MuteDirection } from "@optimiq-voice/common";
import { getVoiceObject, mediaSessionRef, voiceRequest } from "./helpers";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@voice/verbs/unmute", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	// Only test neeed as it shares everything with Mute
	it("should unmute a channel", async function () {
		// Arrange
		const { Unmute } = await import("../src/verbs/Unmute");

		const voice = getVoiceObject(sandbox, "unmuteResponse");

		const unmute = new Unmute(voiceRequest, voice);

		// Act
		await unmute.run({ mediaSessionRef, direction: MuteDirection.IN });

		// Assert
		expect(voice.removeListener).to.have.been.calledOnce;
		expect(voice.on).to.have.been.calledOnce;
		expect(voice.on).to.have.been.calledWith("data", match.func);
		expect(voice.write).to.have.been.calledOnce;
		expect(voice.write).to.have.been.calledWith({
			unmuteRequest: { mediaSessionRef, direction: MuteDirection.IN },
		});
	});
});
