import { Stream as StreamObj } from "stream";
import { z } from "zod";
import {
  Messages,
  StartStreamRequest,
  StopStreamRequest,
  StreamAudioFormat,
  StreamDirection,
  StreamPayload
} from "@optimiq-voice/common";
import { Verb } from "./Verb";

class StartStream extends Verb<StartStreamRequest> {
  getValidationSchema(): z.Schema {
    return z.object({
      direction: z
        .nativeEnum(StreamDirection, { message: "Invalid stream direction" })
        .optional(),
      format: z
        .nativeEnum(StreamAudioFormat, {
          message: "Invalid stream audio direction"
        })
        .optional()
    });
  }
}

class StopStream extends Verb<StopStreamRequest> {
  getValidationSchema(): z.Schema {
    return z.object({
      streamRef: z.string().uuid({ message: Messages.VALID_UUID })
    });
  }
}

class Stream {
  stream: StreamObj;
  constructor() {
    this.stream = new StreamObj();
  }

  close() {
    this.stream.removeAllListeners();
  }

  // Public API
  onPayload(callback: (payload: StreamPayload) => void) {
    this.stream.on("payloadOut", (payload: StreamPayload) => {
      callback(payload);
    });
  }

  write(payload: StreamPayload) {
    this.stream.emit("payloadIn", payload);
  }

  // Private API
  onPayloadIn(callback: (payload: StreamPayload) => void) {
    this.stream.on("payloadIn", (payload) => {
      callback(payload);
    });
  }

  // Private API
  emit(event: "payloadIn" | "payloadOut", payload: StreamPayload) {
    this.stream.emit(event, payload);
  }

  // Private API
  cleanup(callback: () => void) {
    this.stream.on("close", callback);
  }
}

export { StartStream, StopStream, Stream };
