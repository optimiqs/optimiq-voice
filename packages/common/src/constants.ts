import { ServingStatus } from "grpc-health-check";

export const GRPC_NOT_SERVING_STATUS = "NOT_SERVING" as ServingStatus;
export const GRPC_SERVING_STATUS = "SERVING" as ServingStatus;
export const STASIS_APP_NAME = "mediacontroller";
export const CALL_CONTEXT = "local-ctx-common";
export const CALL_EXTENSION = "start";
export const CALL_DETAIL_RECORD_MEASUREMENT = "cdr";
export const INFLUXDB_CALLS_BUCKET = "calls";
export const APP_REF_HEADER = "x-app-ref";
export const ROUTR_DEFAULT_PEER_AOR = "sip:voice@default";
export const AUTOPILOT_SPECIAL_LOCAL_ADDRESS = "autopilot.optimiq-voice.local";
export const AUTOPILOT_INTERNAL_ADDRESS = "autopilot:50061";
export const WELCOME_DEMO_SPECIAL_LOCAL_ADDRESS =
  "welcome.demo.optimiq-voice.local";
