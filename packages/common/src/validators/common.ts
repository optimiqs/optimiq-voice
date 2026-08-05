import { z } from "zod";
import { POSITIVE_INTEGER_MESSAGE, VALID_UUID } from "../messages";

const usernameSchema = z.string().regex(/^[a-z0-9._-]+$/, {
	message: "Must be a lowercase string and with no spaces.",
});

const baseApiObjectSchema = z.object({
	ref: z.string().uuid({
		message: VALID_UUID,
	}),
});

const emptySchema = z.object({});

const listRequestSchema = z
	.object({
		pageSize: z
			.number()
			.int({
				message: POSITIVE_INTEGER_MESSAGE,
			})
			.positive({
				message: POSITIVE_INTEGER_MESSAGE,
			})
			.optional(),
		pageToken: z.string().optional(),
	})
	.optional();

const nameSchema = z.string().min(1, { message: "Value required" });

export { baseApiObjectSchema, emptySchema, listRequestSchema, nameSchema, usernameSchema };
