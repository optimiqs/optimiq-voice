/* eslint-disable @typescript-eslint/ban-types */
import { z } from "zod";
import { withErrorHandling } from "./withErrorHandling";
import { withValidation } from "./withValidation";

function withErrorHandlingAndValidation(fn: Function, schema: z.ZodSchema) {
  return withErrorHandling(withValidation(fn, schema));
}

export { withErrorHandlingAndValidation };
