import { z } from "zod";
import { CallDirection } from "@optimiq-voice/types";

const testCasesSchema = z.object({
  evalsLanguageModel: z.object({
    provider: z.enum(["openai"], {
      message:
        "Invalid language model provider. Only OpenAI is supported for evals."
    }),
    model: z.string(),
    apiKey: z.string().optional()
  }),
  evalsSystemPrompt: z.string().optional(),
  scenarios: z.array(
    z.object({
      ref: z.string(),
      description: z.string(),
      telephonyContext: z.object({
        callDirection: z.nativeEnum(CallDirection),
        ingressNumber: z.string(),
        callerNumber: z.string(),
        metadata: z.record(z.string(), z.string()).optional()
      }),
      conversation: z.array(
        z.object({
          userInput: z.string(),
          expected: z.object({
            text: z.object({
              type: z.enum(["EXACT", "SIMILAR"]),
              response: z.string()
            }),
            tools: z
              .array(
                z.object({
                  tool: z.string(),
                  parameters: z.record(z.string(), z.any())
                })
              )
              .optional()
          })
        })
      )
    })
  )
});

export { testCasesSchema };
