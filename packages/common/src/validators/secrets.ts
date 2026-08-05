import { z } from "zod";

// Allows only letters, numbers, underscores, and hyphens
const validNameRegex = /^[a-zA-Z0-9_-]+$/;

const createSecretRequestSchema = z.object({
  name: z
    .string()
    .regex(validNameRegex, {
      message:
        "Name can only contain letters, numbers, underscores, or hyphens. No spaces allowed"
    })
    .min(3, { message: "Name must be at least 3 characters long" })
    .max(32, { message: "Name must be at most 32 characters long" }),
  secret: z.string()
});

export { createSecretRequestSchema };
