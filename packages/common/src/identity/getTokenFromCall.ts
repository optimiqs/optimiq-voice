import { Metadata, ServerInterceptingCall } from "@grpc/grpc-js";

function getTokenFromCall(call: ServerInterceptingCall) {
	const metadata = (call as unknown as { metadata: Metadata }).metadata.getMap();

	return metadata["token"]?.toString();
}

export { getTokenFromCall };
