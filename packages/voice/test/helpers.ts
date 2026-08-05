import { SinonSandbox } from "sinon";
import { CallDirection } from "@optimiq-voice/types";
import { VoiceRequest } from "../src";

const mediaSessionRef = "848b8803-7106-48b7-b820-515b05c40d6b";
const callRef = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const voiceRequest: VoiceRequest = {
  appRef: "3861b08b-1602-45e4-b523-dc3036ba85e7",
  mediaSessionRef,
  callRef,
  accessKeyId: "WO00000000000000000000000000000000",
  endpoint: "localhost:50061",
  ingressNumber: "+1234567890",
  callerName: "John Doe",
  callerNumber: "+14345551234",
  sessionToken: "jwt-token",
  callDirection: CallDirection.FROM_PSTN,
  metadata: {}
};

function getVoiceObject(sandbox: SinonSandbox, resultContent: string) {
  const onStub = sandbox.stub().callsFake((_, cb) => {
    cb({ content: resultContent });
  });

  return {
    removeListener: sandbox.stub(),
    on: onStub,
    once: onStub,
    write: sandbox.stub(),
    end: sandbox.stub()
  };
}

export { getVoiceObject, mediaSessionRef, callRef, voiceRequest };
