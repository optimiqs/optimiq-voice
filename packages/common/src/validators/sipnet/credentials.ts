import { z } from "zod";
import { nameSchema, usernameSchema } from "../common";

const createCredentialsRequestSchema = z.object({
  name: nameSchema,
  username: usernameSchema,
  password: z.string()
});

const updateCredentialsRequestSchema = z.object({
  name: nameSchema
});

export { createCredentialsRequestSchema, updateCredentialsRequestSchema };
