import * as Validator from "validator";
import { z } from "zod";
import { Transport } from "@optimiq-voice/types";
import { nameSchema } from "../common";

const hostOrIPSchema = z
	.string()
	.refine((host) => Validator.isIP(host, 4) || Validator.isFQDN(host), {
		message: "Must be a valid IP or FQDN",
	});

const createTrunkRequestSchema = z.object({
	name: nameSchema,
	sendRegister: z.boolean(),
	inboundUri: hostOrIPSchema,
	uris: z.array(
		z.object({
			host: hostOrIPSchema,
			port: z.number(),
			transport: z.nativeEnum(Transport, { message: "Invalid transport" }),
			user: z.string().optional(),
			weight: z.number(),
			priority: z.number(),
			enabled: z.boolean(),
		}),
	),
});

const updateTrunkRequestSchema = z.object({});

export { createTrunkRequestSchema, updateTrunkRequestSchema };
