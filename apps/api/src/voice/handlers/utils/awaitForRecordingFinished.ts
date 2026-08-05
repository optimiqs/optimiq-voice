import { status } from "@grpc/grpc-js";
import { Client, RecordingFinished } from "ari-client";
import { GrpcError } from "@optimiq-voice/common";
import { AriEvent } from "../../types";

async function awaitForRecordingFinished(
  ari: Client,
  name: string
): Promise<{ duration: number }> {
  return new Promise((resolve, reject) => {
    const listener = (event: RecordingFinished) => {
      if ("cause" in event.recording) {
        ari.removeListener(AriEvent.RECORDING_FINISHED, listener);
        ari.removeListener(AriEvent.RECORDING_FAILED, listener);
        reject(new GrpcError(status.INTERNAL, "Recording failed"));
      } else if (name === event.recording.name) {
        ari.removeListener(AriEvent.RECORDING_FINISHED, listener);
        ari.removeListener(AriEvent.RECORDING_FAILED, listener);
        resolve({ duration: event.recording.duration });
      }
    };

    ari.on(AriEvent.RECORDING_FINISHED, listener);
    ari.on(AriEvent.RECORDING_FAILED, listener);
  });
}

export { awaitForRecordingFinished };
