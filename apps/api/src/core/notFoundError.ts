import { status } from "@grpc/grpc-js";

const notFoundError = (message: string) => ({
	code: status.NOT_FOUND,
	message,
});

export { notFoundError };
