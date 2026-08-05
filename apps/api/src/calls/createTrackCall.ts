import { NatsConnection } from "nats";
import {
  DialStatus,
  Validators as V,
  withErrorHandlingAndValidation
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject } from "@optimiq-voice/types";
import { CALLS_TRACK_CALL_SUBJECT } from "../envs";
import { CallStream, TrackCallResponse } from "./types";

const FINAL_STATUSES = [
  DialStatus.BUSY,
  DialStatus.FAILED,
  DialStatus.NOANSWER
];

const logger = getLogger({ service: "api", filePath: __filename });

function createTrackCall(nc: NatsConnection) {
  const trackingCallsMap = new Map<string, CallStream>();
  const subscription = nc.subscribe(CALLS_TRACK_CALL_SUBJECT);

  subscription.callback = (err, msg) => {
    // We can't do much more than log the error
    if (err) {
      logger.error("call to subscription.callback", { err });
      return;
    }

    const { ref, status } = msg.json() as TrackCallResponse;

    logger.verbose("call to subscription.callback", { ref, status });

    const stream = trackingCallsMap.get(ref);

    if (!stream) {
      // There is not request to track this call
      return;
    }

    if (FINAL_STATUSES.includes(status)) {
      stream.write({ ref, status });

      setTimeout(() => stream.end(), 500);

      trackingCallsMap.delete(ref);
    } else {
      stream.write({ ref, status });
    }
  };

  const trackCall = (call: { request: BaseApiObject }) => {
    const stream = call as unknown as CallStream;
    const { ref } = call.request;

    logger.verbose("call to trackCall", { ref });

    trackingCallsMap.set(ref, stream);
  };

  return withErrorHandlingAndValidation(trackCall, V.baseApiObjectSchema);
}

export { createTrackCall };
