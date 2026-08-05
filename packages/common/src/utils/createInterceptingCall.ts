import { status as GRPCStatus, ServerInterceptingCall } from "@grpc/grpc-js";

function createInterceptingCall(params: {
  call: ServerInterceptingCall;
  code: GRPCStatus;
  details: string;
}) {
  const { call, code, details } = params;

  call.sendStatus({ code, details });

  return call;
}

export { createInterceptingCall };
