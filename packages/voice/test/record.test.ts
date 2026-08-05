import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox, match } from "sinon";
import sinonChai from "sinon-chai";
import { RecordRequest } from "@optimiq-voice/common";
import { getVoiceObject, mediaSessionRef, voiceRequest } from "./helpers";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@voice/verbs/record", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should record a call", async function () {
    // Arrange
    const { Record } = await import("../src/verbs");

    const voice = getVoiceObject(sandbox, "recordResponse");

    const record = new Record(voiceRequest, voice);

    const recordRequest: RecordRequest = {
      mediaSessionRef,
      maxDuration: 10,
      maxSilence: 5,
      beep: true
    };

    // Act
    await record.run(recordRequest);

    // Assert
    expect(voice.removeListener).to.have.been.calledOnce;
    expect(voice.on).to.have.been.calledOnce;
    expect(voice.on).to.have.been.calledWith("data", match.func);
    expect(voice.write).to.have.been.calledOnce;
    expect(voice.write).to.have.been.calledWith({
      recordRequest
    });
  });
});
