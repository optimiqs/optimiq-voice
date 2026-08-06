import { z } from "zod";
import { ROOT_DOMAIN } from "../../envs";
import { nameSchema } from "../common";

/**
 * A hostname: dot-separated labels that start and end alphanumeric and may contain hyphens
 * inside, followed by an alphabetic TLD of at least two characters.
 *
 * The previous expression was `/^[a-zA-Z0-9-]+(\.[a-zA-Z]{2,})+$/`, which allowed a hyphen
 * **only in the first label**. That was survivable while `ROOT_DOMAIN` was `fonoster.local`, and
 * became a total outage of `Domains/CreateDomain` when it became `optimiq-voice.local`: the
 * second refinement below requires every domain to end with the root domain, so after the rename
 * the two refinements could not both be satisfied by any string at all. Found by the sipnet
 * `createResource` suite once the root mocha run started executing again.
 */
const domainRegex =
	/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

const domainSchema = z
	.string()
	.refine(
		(domain) => {
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
