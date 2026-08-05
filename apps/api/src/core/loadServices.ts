import * as grpc from "@grpc/grpc-js";
import { createServiceDefinition, ServiceDefinitionParams } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

type OptimiqVoiceService = {
	definition: ServiceDefinitionParams;
	handlers: grpc.UntypedServiceImplementation;
};

async function loadServices(server: grpc.Server, services: OptimiqVoiceService[]) {
	services.forEach((service) => {
		const serviceDefinition = createServiceDefinition(service.definition);
		const { serviceName, pckg, version } = service.definition;
		server.addService(serviceDefinition, service.handlers);

		logger.info("loaded service", { serviceName, pckg, version });
	});
}

export default loadServices;
