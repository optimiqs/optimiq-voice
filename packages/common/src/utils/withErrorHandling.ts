/* eslint-disable @typescript-eslint/ban-types */
import { GrpcErrorMessage, handleError } from "../errors";

function withErrorHandling(fn: Function) {
  return async (
    call: { request: unknown },
    callback: (error?: GrpcErrorMessage, response?: unknown) => void
  ) => {
    try {
      await fn(call, callback);
    } catch (error) {
      handleError(error, callback);
    }
  };
}

export { withErrorHandling };
