import * as grpc from "@grpc/grpc-js";
import { createServiceDefinition } from "@optimiq-voice/common";

const VoiceServiceClientConstructor = grpc.makeGenericClientConstructor(
  createServiceDefinition({
    serviceName: "Voice",
    pckg: "voice",
    proto: "voice.proto",
    version: "v1beta2"
  }),
  "",
  {}
);

export { VoiceServiceClientConstructor };
