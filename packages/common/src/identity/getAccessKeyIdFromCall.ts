import { Metadata, ServerInterceptingCall } from "@grpc/grpc-js";

function getAccessKeyIdFromCall(call: ServerInterceptingCall) {
	const metadata = (call as unknown as { metadata: Metadata }).metadata.getMap();

	return metadata["accesskeyid"]?.toString();
}

export { getAccessKeyIdFromCall };
