import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { MuteDirection } from "@optimiq-voice/common";
import { createMuteHandler } from "../../src/voice/handlers/createMuteHandler";
import { getAriStub, getCreateVoiceClient } from "./helper";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

const channelId = "channel-id";

describe("@voice/handler/Mute", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should handle a Mute command", async function () {
    // Arrange
    const ari = getAriStub(sandbox);

    const createVoiceClient = getCreateVoiceClient(sandbox);

    const muteRequest = {
      mediaSessionRef: channelId,
      direction: MuteDirection.BOTH
    };

    // Act
    await createMuteHandler(ari, createVoiceClient())(muteRequest);

    // Assert
    expect(createVoiceClient().sendResponse).to.have.been.calledOnce;
    expect(ari.channels.mute).to.have.been.calledOnce;
    expect(ari.channels.mute).to.have.been.calledWith({
      channelId,
      direction: muteRequest.direction
    });
  });
});
