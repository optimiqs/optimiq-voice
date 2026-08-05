import * as grpc from "@grpc/grpc-js";
import { createServiceDefinition } from "../utils";

type GetPublicKeyResponse = {
	publicKey: string;
};

const IdentityServiceClient = grpc.makeGenericClientConstructor(
	createServiceDefinition({
		serviceName: "Identity",
		pckg: "identity",
		proto: "identity.proto",
		version: "v1beta2",
	}),
	"",
	{},
);

function getPublicKey(endpoint: string, allowInsecure: boolean = false) {
	return new Promise<GetPublicKeyResponse>((resolve, reject) => {
		const client = new IdentityServiceClient(
			endpoint,
			allowInsecure ? grpc.credentials.createInsecure() : grpc.credentials.createSsl(),
		);

		client.getPublicKey({}, (error: grpc.ServiceError, response: GetPublicKeyResponse) => {
			if (error) {
				reject(error);
			} else {
				resolve(response);
			}
		});
	});
}

export { getPublicKey };
