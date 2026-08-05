import { z } from "zod";

const ListApplicationsSchema = z.object({
  page_size: z.number().optional().describe("Number of applications per page"),
  page_token: z.string().optional().describe("Token for pagination")
});

const ListNumbersSchema = z.object({
  page_size: z.number().optional().describe("Number of numbers per page"),
  page_token: z.string().optional().describe("Token for pagination")
});

const CreateCallSchema = z.object({
  from: z.string().describe("The phone number to call from"),
  to: z.string().describe("The phone number to call to"),
  app_ref: z.string().describe("The application reference to use for the call"),
  timeout: z.number().optional().describe("The timeout for the call"),
  metadata: z
    .record(z.string(), z.any())
    .optional()
    .describe("The metadata to send to the Voice Application")
});

const CreateCallBatchSchema = z.object({
  from: z.string().min(1),
  to_array: z.array(z.string().min(1)).min(1),
  app_ref: z.string().min(1),
  timeout: z.number().optional(),
  metadata: z
    .record(z.string(), z.any())
    .optional()
    .describe("The metadata to send to the Voice Application"),
  calls_per_minute: z.number().min(1).max(60).optional().default(20)
});

export {
  ListApplicationsSchema,
  CreateCallSchema,
  ListNumbersSchema,
  CreateCallBatchSchema
};
