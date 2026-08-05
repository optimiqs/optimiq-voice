import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import sinon, { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { createPlayHandler } from "../../src/voice/handlers/createPlayHandler";
import { AriEvent } from "../../src/voice/types";
import { getAriStub, getCreateVoiceClient } from "./helper";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

const channelId = "channel-id";

describe("@voice/handler/Play", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should handle a Play command", async function () {
		// Arrange
		const ari = getAriStub(sandbox);

		const onStub = ari.on as sinon.SinonStub;

		onStub.withArgs(AriEvent.PLAYBACK_FINISHED).callsFake((_, cb) => {
			cb({}, { id: playRequest.playbackRef });
		});

		const createVoiceClient = getCreateVoiceClient(sandbox);

		const playRequest = {
			playbackRef: "playbackRef",
			mediaSessionRef: channelId,
			url: "url",
		};

		// Act
		await createPlayHandler(ari, createVoiceClient())(playRequest);

		// Assert
		expect(ari.channels.play).to.have.been.calledOnce;
		expect(createVoiceClient().sendResponse).to.have.been.calledOnce;
		expect(createVoiceClient().sendResponse).to.have.been.calledWith({
			playResponse: {
				playbackRef: playRequest.playbackRef,
				mediaSessionRef: playRequest.mediaSessionRef,
			},
		});
		expect(ari.channels.play).to.have.been.calledWith({
			channelId,
			media: `sound:${playRequest.url}`,
			playbackId: playRequest.playbackRef,
		});
	});
});
