type GatherStream = {
  stop: () => Promise<void>;
  onData: (
    cb: (payload: { speech: string; responseTime: number }) => void
  ) => void;
};

type Stream = {
  stop: () => Promise<void>;
  onData: (cb: (chunk: Uint8Array) => void) => void;
};

type TransferOptions = {
  timeout?: number;
  record?: boolean;
};

type Voice = {
  mediaSessionRef: string;
  answer: () => Promise<void>;
  hangup: () => Promise<void>;
  say: (text: string) => Promise<void>;
  playDtmf: (dtmf: string) => Promise<void>;
  sgather: () => Promise<GatherStream>;
  transfer: (destination: string, options?: TransferOptions) => Promise<void>;
  stream: () => Promise<Stream>;
  stopSpeech: () => Promise<void>;
  stopStreams: () => Promise<void>;
};

export { TransferOptions, Voice };
