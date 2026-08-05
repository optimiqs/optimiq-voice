import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox, match } from "sinon";
import sinonChai from "sinon-chai";
import { GatherRequest, GatherSource } from "@optimiq-voice/common";
import { getVoiceObject, mediaSessionRef, voiceRequest } from "./helpers";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@voice/verbs/gather", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should gather speech or dtmf", async function () {
    // Arrange
    const { Gather } = await import("../src/verbs");

    const voice = getVoiceObject(sandbox, "gatherResponse");

    const gather = new Gather(voiceRequest, voice);

    const gatherRequest: GatherRequest = {
      mediaSessionRef,
      timeout: 10,
      maxDigits: 1,
      source: GatherSource.SPEECH_AND_DTMF
    };

    // Act
    await gather.run(gatherRequest);

    // Assert
    expect(voice.removeListener).to.have.been.calledOnce;
    expect(voice.on).to.have.been.calledOnce;
    expect(voice.on).to.have.been.calledWith("data", match.func);
    expect(voice.write).to.have.been.calledOnce;
    expect(voice.write).to.have.been.calledWith({
      gatherRequest
    });
  });
});
