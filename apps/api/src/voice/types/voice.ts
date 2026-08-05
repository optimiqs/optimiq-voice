import { Readable, Stream } from "stream";
import * as grpc from "@grpc/grpc-js";
import {
  SayOptions,
  StreamContent,
  VoiceClientConfig,
  VoiceIn,
  VoiceSessionStreamClient
} from "@optimiq-voice/common";
import { SpeechResult, StreamSpeech } from "../stt/types";

type VoiceClient = {
  config: VoiceClientConfig;
  sendResponse: (command: VoiceIn) => void;
  on: (type: StreamContent, callback: (data: VoiceIn) => void) => void;
  connect: () => Promise<void>;
  close: () => void;
  synthesize: (text: string, options: SayOptions) => Promise<string>;
  transcribe: () => Promise<SpeechResult>;
  startSpeechGather: (
    callback: (stream: { speech: string; responseTime: number }) => void
  ) => void;
  startDtmfGather: (
    mediaSessionRef: string,
    callback: (event: { digit: string }) => void
  ) => void;
  // Stops both speech and dtmf gather
  stopStreamGather: () => void;
  waitForDtmf: (params: {
    mediaSessionRef: string;
    finishOnKey: string;
    maxDigits: number;
    timeout: number;
    onDigitReceived: () => void;
  }) => Promise<{ digits: string }>;
  getTranscriptionsStream: () => Stream;
  stopSynthesis: () => Promise<void>;
};

type TextToSpeech = {
  synthesize: (
    text: string,
    options: Record<string, unknown>
  ) => { ref: string; stream: Readable };
};

type SpeechToText = {
  transcribe: (stream: Stream) => Promise<SpeechResult>;
  streamTranscribe(stream: Stream): StreamSpeech;
};

type GRPCClient = {
  createSession: (metadata: grpc.Metadata) => VoiceSessionStreamClient;
  close: () => void;
};

export { GRPCClient, SpeechToText, TextToSpeech, VoiceClient };
