import { GrpcErrorMessage } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "identity", filePath: __filename });

type GetPublicKeyResponse = {
	publicKey: string;
};

function createGetPublicKey(publicKey: string) {
	return async function getPublicKey(
		_: unknown,
		callback: (error: GrpcErrorMessage, response?: GetPublicKeyResponse) => void,
	) {
		logger.verbose("getting public key for JWT verification");

		callback(null, { publicKey });
	};
}

export { createGetPublicKey };
