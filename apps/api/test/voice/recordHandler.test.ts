import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import sinon, { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { createRecordHandler } from "../../src/voice/handlers/createRecordHandler";
import { AriEvent } from "../../src/voice/types";
import { getAriStub, getCreateVoiceClient } from "./helper";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@voice/handler/Record", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should handle the Record command", async function () {
    // Arrange
    const ari = getAriStub(sandbox);

    const recordingName = "recordingName";
    const mediaSessionRef = "mediaSessionRef";

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nanoid = require("nanoid");
    sandbox.stub(nanoid, "nanoid").returns(recordingName);

    const onStub = ari.on as sinon.SinonStub;

    onStub.withArgs(AriEvent.RECORDING_FINISHED).callsFake((_, cb) => {
      cb({ recording: { name: recordingName } });
    });

    const createVoiceClient = getCreateVoiceClient(sandbox);

    const recordRequest = {
      beep: true,
      finishOnKey: "#",
      maxDuration: 10,
      maxSilence: 5,
      mediaSessionRef
    };

    // Act
    await createRecordHandler(ari, createVoiceClient())(recordRequest);

    // Assert
    expect(ari.channels.record).to.have.been.calledOnce;
  });

  it("should handle the Record command with a failed recording", async function () {
    // Arrange
    const ari = getAriStub(sandbox);

    const recordingName = "recordingName";
    const mediaSessionRef = "mediaSessionRef";

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nanoid = require("nanoid");
    sandbox.stub(nanoid, "nanoid").returns(recordingName);

    const onStub = ari.on as sinon.SinonStub;

    onStub.withArgs(AriEvent.RECORDING_FAILED).callsFake((_, cb) => {
      cb({ recording: { name: recordingName, cause: "cause" } });
    });

    const createVoiceClient = getCreateVoiceClient(sandbox);

    const recordRequest = {
      beep: true,
      finishOnKey: "#",
      maxDuration: 10,
      maxSilence: 5,
      mediaSessionRef
    };

    // Act
    const promise = createRecordHandler(
      ari,
      createVoiceClient()
    )(recordRequest);

    // Assert
    await expect(promise).to.eventually.be.rejectedWith("Recording failed");
  });
});
