export interface ULog {
  accessKeyId: string;
  eventType: ULogType;
  level: "info" | "error" | "verbose" | "warn";
  message: string;
  body?: Record<string, unknown>;
}

export enum ULogType {
  APP = "app",
  CALL = "call",
  SIP = "sip"
}
