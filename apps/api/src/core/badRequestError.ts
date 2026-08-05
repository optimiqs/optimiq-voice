import { status } from "@grpc/grpc-js";

const badRequestError = (message: string) => ({
	code: status.INVALID_ARGUMENT,
	message,
});

export { badRequestError };
