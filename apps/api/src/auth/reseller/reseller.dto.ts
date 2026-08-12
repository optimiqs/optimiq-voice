import { z } from "zod/v4";

/**
 * The request bodies for the reseller surface. Kept Zod-validated like every other write on this
 * platform; `organizationId`/`parentOrganizationId` are NEVER accepted from a body — the parent is
 * always the acting session's own organization, resolved server-side.
 */

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const createChildDto = z.strictObject({
	name: z.string().trim().min(1).max(100),
	/** Optional; derived from the name when omitted. Lower-kebab, globally unique across orgs. */
	slug: z.string().trim().min(1).max(60).regex(slugPattern).optional(),
});
export type CreateChildInput = z.output<typeof createChildDto>;

export const suspendChildDto = z.strictObject({
	suspended: z.boolean(),
});
export type SuspendChildInput = z.output<typeof suspendChildDto>;

/**
 * Derive a globally-unique slug from a display name. A short random suffix avoids collisions with
 * an existing organization's slug (the column is unique) without a read-then-write race.
 */
export function deriveSlug(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 40);
	const suffix = Math.random().toString(36).slice(2, 8);
	return base.length > 0 ? `${base}-${suffix}` : `org-${suffix}`;
}
