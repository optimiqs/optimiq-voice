import { z } from "zod";
import { withErrorHandling, withValidation } from "@optimiq-voice/common";
import { withAccess } from "@optimiq-voice/identity";

function withErrorHandlingAndValidationAndAccess<T, A>(
  handler: (call: T) => Promise<A>,
  getFn: (ref: string) => Promise<unknown>,
  schema: z.ZodSchema
) {
  // Start by applying access logic, then validation, and finally error handling
  const withAccessHandler = withAccess(handler, getFn);
  const withValidationHandler = withValidation(withAccessHandler, schema);
  return withErrorHandling(withValidationHandler);
}

export { withErrorHandlingAndValidationAndAccess };
