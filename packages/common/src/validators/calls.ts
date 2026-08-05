import { z } from "zod";
import { CallStatus, CallType } from "@optimiq-voice/types";
import { POSITIVE_INTEGER_MESSAGE, VALID_DATE } from "../messages";

const createCallRequestSchema = z.object({
  from: z.string(),
  to: z.string(),
  appRef: z.string().uuid({ message: "Invalid call reference" }),
  timeout: z
    .number()
    .max(120, { message: "Timeout must be less than 120s" })
    .default(30),
  metadata: z.record(z.string(), z.any()).optional()
});

const getCallRequestSchema = z.object({
  ref: z.string().uuid({ message: "Invalid call reference" })
});

const listCallsRequestSchema = z.object({
  after: z.string().datetime({ offset: true, message: VALID_DATE }).optional(),
  before: z.string().datetime({ offset: true, message: VALID_DATE }).optional(),
  pageSize: z
    .number()
    .int({
      message: POSITIVE_INTEGER_MESSAGE
    })
    .positive({
      message: POSITIVE_INTEGER_MESSAGE
    })
    .optional(),
  type: z
    .nativeEnum(CallType, {
      message: "Invalid call type"
    })
    .optional(),
  status: z
    .nativeEnum(CallStatus, { message: "Invalid call status" })
    .optional(),
  pageToken: z.string().optional()
});

export {
  createCallRequestSchema,
  getCallRequestSchema,
  listCallsRequestSchema
};
