import { Stream } from "stream";
import { z } from "zod";
import {
  DialRecordDirection,
  DialRequest,
  DialStatus,
  Messages
} from "@optimiq-voice/common";
import { Verb } from "./Verb";

class Dial extends Verb<DialRequest> {
  getValidationSchema(): z.Schema {
    return z.object({
      destination: z.string(),
      timeout: z
        .number()
        .int({ message: Messages.POSITIVE_INTEGER_MESSAGE })
        .positive({ message: Messages.POSITIVE_INTEGER_MESSAGE })
        .optional(),
      recordDirection: z
        .nativeEnum(DialRecordDirection, {
          message: "Invalid record direction."
        })
        .optional()
    });
  }
}

class DialStatusStream {
  stream: Stream;
  constructor() {
    this.stream = new Stream();
  }

  close() {
    this.stream.removeAllListeners();
  }

  on(callback: (data: DialStatus) => void) {
    this.stream.on("status", (data) => {
      callback(data);
    });
  }

  emit(status: DialStatus) {
    this.stream.emit("status", status);
  }
}

export { Dial, DialStatusStream };
