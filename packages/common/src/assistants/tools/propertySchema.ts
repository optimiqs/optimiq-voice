import { z } from "zod";

const propertySchema = z
  .object({
    type: z.string(),
    // NOTICE: We are adopting Gemini's format which only supports 'enum' and 'date-time'
    format: z.enum(["enum", "date-time"]).optional(),
    pattern: z.string().optional()
  })
  .refine(
    (data) => {
      return !("format" in data && "pattern" in data);
    },
    {
      message: "Property can only have either 'format' or 'pattern', not both."
    }
  );

export { propertySchema };
