import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { MuteDirection } from "@optimiq-voice/common";
import { createUnmuteHandler } from "../../src/voice/handlers/createUnmuteHandler";
import { getAriStub, getCreateVoiceClient } from "./helper";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

const channelId = "channel-id";

describe("@voice/handler/Unmute", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should handle a Unmute command", async function () {
		// Arrange
		const ari = getAriStub(sandbox);

		const createVoiceClient = getCreateVoiceClient(sandbox);

		const unmuteRequest = {
			mediaSessionRef: channelId,
			direction: MuteDirection.BOTH,
		};

		// Act
		await createUnmuteHandler(ari, createVoiceClient())(unmuteRequest);

		// Assert
		expect(createVoiceClient().sendResponse).to.have.been.calledOnce;
		expect(ari.channels.unmute).to.have.been.calledOnce;
		expect(ari.channels.unmute).to.have.been.calledWith({
			channelId,
			direction: unmuteRequest.direction,
		});
		expect(ari.channels.mute).to.not.have.been.called;
	});
});
