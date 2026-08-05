import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { createHangupHandler } from "../../src/voice/handlers/createHangupHandler";
import { getAriStub, getCreateVoiceClient } from "./helper";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

const channelId = "channel-id";

describe("@voice/handler/Hangup", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should handle a Hangup command", async function () {
    // Arrange
    const ari = getAriStub(sandbox);

    const createVoiceClient = getCreateVoiceClient(sandbox);

    const hangupRequest = {
      mediaSessionRef: channelId
    };

    // Act
    await createHangupHandler(ari, createVoiceClient())(hangupRequest);

    // Wait for 3 seconds to allow the hangup to complete
    await new Promise((resolve) => setTimeout(resolve, 4000));

    // Assert
    expect(createVoiceClient().close).to.have.been.calledOnce;
    expect(ari.channels.hangup).to.have.been.calledOnce;
    expect(ari.channels.hangup).to.have.been.calledWith({ channelId });
  }).timeout(5000);
});
