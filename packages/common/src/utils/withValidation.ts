/* eslint-disable @typescript-eslint/ban-types */
import { z } from "zod";
import { GrpcErrorMessage } from "../errors";

function withValidation(fn: Function, schema: z.ZodSchema) {
  return async (
    call: { request: unknown },
    callback: (error?: GrpcErrorMessage, response?: unknown) => void
  ) => {
    schema.parse(call.request);
    await fn(call, callback);
  };
}

export { withValidation };
