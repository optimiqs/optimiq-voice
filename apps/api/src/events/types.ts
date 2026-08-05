type RegisterEvent = {
  // The address of record (aor) is the unique identifier for the endpoint
  // And it is formatted as `sip:username@domain`
  aor: string;
  registeredAt: Date;
  expires: number;
  extraHeaders: Record<string, string>;
};

type NatsEventCallback = (registerEvent: Record<string, unknown>) => void;

export { NatsEventCallback, RegisterEvent };
