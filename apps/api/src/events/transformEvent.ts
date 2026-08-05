import { v4 as uuidv4 } from "uuid";
import { CallType } from "@optimiq-voice/types";
import { mapCallDirectionToEnum } from "./mapCallDirectionToEnum";

const ACCESS_KEY_ID_HEADER = "X-Access-Key-Id";
const CALL_REF_HEADER = "X-Call-Ref";
const CALL_DIRECTION_HEADER = "X-Call-Direction";
const DOD_NUMBER_HEADER = "X-Dod-Number";
const API_ORIGINATED_TYPE_HEADER = "X-Is-Api-Originated-Type";

function transformEvent(
  event: Record<string, unknown>
): Record<string, unknown> {
  const transformedEvent: Record<string, unknown> = { ...event };

  if (event.startTime) {
    const time = new Date(event.startTime as string).getTime() / 1000;
    transformedEvent.startedAt = time;
    transformedEvent.endedAt = time;
    delete transformedEvent.startTime;
  }

  if (event.endTime) {
    transformedEvent.endedAt =
      new Date(event.endTime as string).getTime() / 1000;
    delete transformedEvent.endTime;
  }

  if (event.hangupCause) {
    transformedEvent.status = event.hangupCause;
    delete transformedEvent.hangupCause;
  }

  if (event.to) {
    const to = event.to as string;
    transformedEvent.to = to.split("@")[0].replace("sip:", "");
  }

  const extraHeaders = event.extraHeaders as Record<string, string>;

  if (extraHeaders && Object.keys(extraHeaders).length > 0) {
    if (extraHeaders[ACCESS_KEY_ID_HEADER]) {
      transformedEvent.accessKeyId = extraHeaders[ACCESS_KEY_ID_HEADER];
    }

    if (extraHeaders[CALL_REF_HEADER]) {
      transformedEvent.ref = extraHeaders[CALL_REF_HEADER];
    } else {
      // SIP originated calls don't have a ref so we need to create one
      transformedEvent.ref = uuidv4();
    }

    if (extraHeaders[DOD_NUMBER_HEADER]) {
      transformedEvent.from = extraHeaders[DOD_NUMBER_HEADER];
    }

    if (extraHeaders[API_ORIGINATED_TYPE_HEADER]) {
      transformedEvent.type = CallType.API_ORIGINATED;
    }

    if (extraHeaders[CALL_DIRECTION_HEADER]) {
      transformedEvent.direction = mapCallDirectionToEnum(
        extraHeaders[CALL_DIRECTION_HEADER]
      );
    }
  }

  // Delete the extra headers as they may contain sensitive information
  delete transformedEvent.extraHeaders;
  delete transformedEvent.callId;

  return transformedEvent;
}

export { transformEvent };
