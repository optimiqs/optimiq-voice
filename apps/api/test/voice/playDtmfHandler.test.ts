import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { createPlayDtmfHandler } from "../../src/voice/handlers/createPlayDtmfHandler";
import { getAriStub, getCreateVoiceClient } from "./helper";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

const channelId = "channel-id";

describe("@voice/handler/PlayDtmf", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should handle a PlayDtmf command", async function () {
		// Arrange
		const ari = getAriStub(sandbox);

		const createVoiceClient = getCreateVoiceClient(sandbox);

		const playDtmfRequest = {
			mediaSessionRef: channelId,
			digits: "123",
		};

		// Act
		await createPlayDtmfHandler(ari, createVoiceClient())(playDtmfRequest);

		// Assert
		expect(ari.channels.sendDTMF).to.have.been.calledOnce;
		expect(createVoiceClient().sendResponse).to.have.been.calledOnce;
		expect(createVoiceClient().sendResponse).to.have.been.calledWith({
			playDtmfResponse: {
				mediaSessionRef: channelId,
			},
		});
		expect(ari.channels.sendDTMF).to.have.been.calledWith({
			channelId,
			dtmf: playDtmfRequest.digits,
		});
	});
});
