import { Stream as StreamObj } from "stream";
import { z } from "zod";
import {
  Messages,
  StartStreamGatherRequest,
  StreamGatherPayload,
  StreamGatherSource,
  VerbRequest
} from "@optimiq-voice/common";
import { Verb } from "./Verb";

class StartStreamGather extends Verb<StartStreamGatherRequest> {
  getValidationSchema(): z.Schema {
    return z.object({
      source: z.optional(
        z.nativeEnum(StreamGatherSource, {
          message: "Invalid stream gather source."
        })
      )
    });
  }
}

class StopStreamGather extends Verb<VerbRequest> {
  getValidationSchema(): z.Schema {
    return z.object({
      sessionRef: z.string().uuid({ message: Messages.VALID_UUID })
    });
  }
}

class StreamGatherStream {
  stream: StreamObj;
  constructor() {
    this.stream = new StreamObj();
  }

  close() {
    this.stream.removeAllListeners();
  }

  // Private API
  onPayload(callback: (payload: StreamGatherPayload) => void) {
    this.stream.on("data", (payload) => {
      callback(payload);
    });
  }

  // Private API
  emit(event: "data", payload: StreamGatherPayload) {
    this.stream.emit(event, payload);
  }

  // Private API
  cleanup(callback: () => void) {
    this.stream.on("close", callback);
  }
}

export { StartStreamGather, StopStreamGather, StreamGatherStream };
