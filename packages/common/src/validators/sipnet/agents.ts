import { z } from "zod";
import { POSITIVE_INTEGER_MESSAGE } from "../../messages";
import { nameSchema, usernameSchema } from "../common";

const createAgentRequestSchema = z.object({
	name: nameSchema,
	username: usernameSchema,
	privacy: z.enum(["PRIVATE", "NONE"]).optional(),
	enabled: z.boolean().optional(),
	maxContacts: z.number().positive({ message: POSITIVE_INTEGER_MESSAGE }).optional(),
	expires: z.number().positive({ message: POSITIVE_INTEGER_MESSAGE }).optional(),
});

const updateAgentRequestSchema = z.object({
	name: nameSchema.optional(),
	privacy: z.enum(["PRIVATE", "NONE"]).optional(),
	enabled: z.boolean().optional(),
	maxContacts: z.number().positive({ message: POSITIVE_INTEGER_MESSAGE }).optional(),
	expires: z.number().positive({ message: POSITIVE_INTEGER_MESSAGE }).optional(),
});

export { createAgentRequestSchema, updateAgentRequestSchema };
