import { createServiceDefinition } from "@optimiq-voice/common";

const serviceDefinition = createServiceDefinition({
	serviceName: "Voice",
	pckg: "voice",
	proto: "voice.proto",
	version: "v1beta2",
});

export { serviceDefinition };
