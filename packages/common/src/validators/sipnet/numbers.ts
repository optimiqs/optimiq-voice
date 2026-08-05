import isISO31661Alpha2 from "validator/lib/isISO31661Alpha2";
import { z } from "zod";
import { nameSchema } from "../common";

const sipUriRegex = /^sip:[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$/;
const sipUriSchema = z.string().regex(sipUriRegex, "Invalid SIP URI");

const countryIsoCodeSchema = z.string().refine((val) => isISO31661Alpha2(val), {
	message: "Invalid country ISO code",
});

const createNumberRequestSchema = z
	.object({
		name: nameSchema,
		telUrl: z.string(),
		city: z.string(),
		country: z.string(),
		agentAor: sipUriSchema.optional(),
		appRef: z.string().optional(),
		countryIsoCode: countryIsoCodeSchema,
	})
	.refine(({ agentAor, appRef }) => !(agentAor !== undefined && appRef !== undefined), {
		message: "You can only provide one of the following fields: 'agentAor' or 'appRef'",
	});

const updateNumberRequestSchema = z
	.object({
		name: nameSchema.optional(),
		agentAor: sipUriSchema.optional(),
		appRef: z.string().optional(),
	})
	.refine(({ agentAor, appRef }) => !(agentAor !== undefined && appRef !== undefined), {
		message: "You can only provide one of the following fields: 'agentAor' or 'appRef'",
	});

export { createNumberRequestSchema, updateNumberRequestSchema };
