import { z } from "zod";
import * as Messages from "../../messages";
import { AllowedHttpMethod } from "../../utils/sendHttpRequest";
import { propertySchema } from "./propertySchema";

const toolSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.object({
    type: z.enum(["object", "array"]),
    properties: z.record(propertySchema),
    required: z.array(z.string()).optional()
  }),
  requestStartMessage: z.string().optional(),
  operation: z.object({
    method: z
      .nativeEnum(AllowedHttpMethod, {
        message: "Invalid method"
      })
      .default(AllowedHttpMethod.GET),
    url: z.string().url({ message: Messages.VALID_URL }),
    waitForResponse: z.boolean().default(true),
    headers: z
      .record(z.string(), z.string())
      .refine(
        (headers) =>
          !Object.keys(headers || {}).some(
            (key) =>
              key.toLowerCase() === "accept" ||
              key.toLowerCase() === "content-type"
          ),
        {
          message:
            "Headers cannot include 'accept' or 'content-type' as they are set internally"
        }
      )
      .optional()
  })
});

export { toolSchema };
