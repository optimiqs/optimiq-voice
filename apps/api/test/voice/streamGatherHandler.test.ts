import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox, match } from "sinon";
import sinonChai from "sinon-chai";
import { StreamGatherSource } from "@optimiq-voice/common";
import { createStreamGatherHandler } from "../../src/voice/handlers/createStreamGatherHandler";
import { getCreateVoiceClient } from "./helper";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@voice/handler/StreamHeader", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should handle the StreamGather command", async function () {
    // Arrange
    const createVoiceClient = getCreateVoiceClient(sandbox);

    const streamGatherRequest = {
      mediaSessionRef: "mediaSessionRef",
      source: "speech"
    };

    const voiceClient = createVoiceClient();

    // Act
    await createStreamGatherHandler(voiceClient)(streamGatherRequest);

    // Assert
    expect(voiceClient.startSpeechGather).to.have.been.calledOnce;
    expect(voiceClient.startSpeechGather).to.have.been.calledWith(match.func);
    expect(voiceClient.startDtmfGather).to.not.have.been.called;
  });

  it("should handle the StreamGather command with DTMF", async function () {
    // Arrange
    const createVoiceClient = getCreateVoiceClient(sandbox);

    const streamGatherRequest = {
      mediaSessionRef: "mediaSessionRef",
      source: StreamGatherSource.SPEECH_AND_DTMF
    };

    const voiceClient = createVoiceClient();

    // Act
    await createStreamGatherHandler(voiceClient)(streamGatherRequest);

    // Assert
    expect(voiceClient.startDtmfGather).to.have.been.calledOnce;
    expect(voiceClient.startDtmfGather).to.have.been.calledWith(
      "mediaSessionRef",
      match.func
    );
    expect(voiceClient.startSpeechGather).to.have.been.calledOnce;
  });
});
