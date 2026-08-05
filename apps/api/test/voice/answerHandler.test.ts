import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { createAnswerHandler } from "../../src/voice/handlers/createAnswerHandler";
import { getAriStub, getCreateVoiceClient } from "./helper";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

const channelId = "channel-id";

describe("@voice/handler/Answer", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should handle an Answer command", async function () {
    // Arrange
    const ari = getAriStub(sandbox);

    const createVoiceClient = getCreateVoiceClient(sandbox);

    const verbRequest = {
      mediaSessionRef: channelId
    };

    // Act
    await createAnswerHandler(ari, createVoiceClient())(verbRequest);

    // Assert
    expect(ari.channels.answer).to.have.been.calledOnce;
    expect(createVoiceClient().sendResponse).to.have.been.calledOnce;
    expect(createVoiceClient().sendResponse).to.have.been.calledWith({
      answerResponse: {
        mediaSessionRef: verbRequest.mediaSessionRef
      }
    });
  });
});
