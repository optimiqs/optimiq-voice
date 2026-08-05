import { createServiceDefinition } from "@optimiq-voice/common";

const serviceDefinition = createServiceDefinition({
	serviceName: "Authz",
	pckg: "authz",
	proto: "authz.proto",
	version: "v1beta2",
});

export { serviceDefinition };
