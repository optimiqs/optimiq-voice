import { z } from "zod";
import { ROOT_DOMAIN } from "../../envs";
import { nameSchema } from "../common";

const domainSchema = z
	.string()
	.refine(
		(domain) => {
			const domainRegex = /^[a-zA-Z0-9-]+(\.[a-zA-Z]{2,})+$/;
			return domainRegex.test(domain);
		},
		{
			message: `Invalid domain format. Should be like: "acme.${ROOT_DOMAIN}"`,
		},
	)
	.refine(
		(domain) => {
			return domain.endsWith(ROOT_DOMAIN);
		},
		{
			message: `Domain must end with "${ROOT_DOMAIN}"`,
		},
	);

const createDomainRequestSchema = z.object({
	name: nameSchema,
	domainUri: domainSchema,
	egressPolicies: z
		.array(
			z.object({
				rule: z.string(),
			}),
		)
		.optional(),
});

const updateDomainRequestSchema = z.object({
	name: nameSchema.optional(),
	egressPolicies: z
		.array(
			z.object({
				rule: z.string(),
			}),
		)
		.optional(),
});

export { createDomainRequestSchema, updateDomainRequestSchema };
