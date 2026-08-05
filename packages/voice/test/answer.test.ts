import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { getVoiceObject, mediaSessionRef, voiceRequest } from "./helpers";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@voice/verbs/answer", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should answer a call", async function () {
		// Arrange
		const voice = getVoiceObject(sandbox, "answerResponse");

		const { Answer } = await import("../src/verbs");

		const answer = new Answer(voiceRequest, voice);

		// Act
		await answer.run();

		// Assert
		expect(voice.removeListener).to.have.been.calledOnce;
		expect(voice.on).to.have.been.calledOnce;
		expect(voice.write).to.have.been.calledOnce;
		expect(voice.write).to.have.been.calledWith({
			answerRequest: { mediaSessionRef },
		});
	});
});
