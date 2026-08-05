import { z } from "zod";
import { assistantSchema } from "@optimiq-voice/common";

const assistantWithoutApiKeySchema = assistantSchema.extend({
  languageModel: assistantSchema.shape.languageModel.superRefine(
    (data, ctx) => {
      if ("apiKey" in data) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "apiKey is not allowed in languageModel",
          path: ["apiKey"]
        });
      }
    }
  )
});

export { assistantWithoutApiKeySchema };
