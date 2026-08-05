import { ServerInterceptingCall, status } from "@grpc/grpc-js";
import { createInterceptingCall } from "../utils";

const unauthenticatedError = (call: ServerInterceptingCall) =>
  createInterceptingCall({
    call,
    code: status.UNAUTHENTICATED,
    details: "Invalid or expired token"
  });

const permissionDeniedError = (call: ServerInterceptingCall) =>
  createInterceptingCall({
    call,
    code: status.PERMISSION_DENIED,
    details: "Permission denied"
  });

export { permissionDeniedError, unauthenticatedError };
