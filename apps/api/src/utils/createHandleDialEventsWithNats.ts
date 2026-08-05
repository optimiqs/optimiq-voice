import { NatsConnection } from "nats";
import { CALLS_TRACK_CALL_SUBJECT } from "../envs";
import { mapDialStatus } from "./mapDialStatus";

function createHandleDialEventsWithNats(nc: NatsConnection) {
  return async function handleDialEventsWithNats(
    callRef: string,
    event: { dialstatus: string }
  ) {
    const mappedStatus = mapDialStatus(event.dialstatus);
    if (!mappedStatus) return; // Ignore the event if status is not mapped

    nc.publish(
      CALLS_TRACK_CALL_SUBJECT,
      JSON.stringify({ ref: callRef, status: mappedStatus })
    );
  };
}

export { createHandleDialEventsWithNats };
