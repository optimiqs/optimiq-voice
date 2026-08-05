import { z } from "zod";

export const conversationSettingsSchema = z.object({
  firstMessage: z.string().optional(),
  systemPrompt: z.string(),
  goodbyeMessage: z.string(),
  systemErrorMessage: z.string(),
  transferOptions: z
    .object({
      phoneNumber: z.string(),
      message: z.string(),
      timeout: z.number().int().positive().optional()
    })
    .optional(),
  idleOptions: z.object({
    message: z.string(),
    timeout: z.number().int().positive().optional(),
    maxTimeoutCount: z.number().int().positive().optional()
  }),
  allowUserBargeIn: z.boolean().optional().default(true)
});
