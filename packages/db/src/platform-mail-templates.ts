import { and, eq } from "drizzle-orm";
import { organizationMailTemplate } from "./schema/platform/organization-platform-schema";
import type { AdminDatabase } from "./client";

/**
 * Reads and writes over per-organization mail-template overrides — the base-database repository the
 * mail cascade resolves through. Built with this package's Drizzle for the version-pin reason the
 * other platform repositories state.
 */

export interface MailTemplateRow {
	readonly id: string;
	readonly organizationId: string;
	readonly templateKey: string;
	readonly language: string;
	readonly subject: string | null;
	readonly bodyIntro: string | null;
	readonly enabled: boolean;
}

const COLUMNS = {
	id: organizationMailTemplate.id,
	organizationId: organizationMailTemplate.organizationId,
	templateKey: organizationMailTemplate.templateKey,
	language: organizationMailTemplate.language,
	subject: organizationMailTemplate.subject,
	bodyIntro: organizationMailTemplate.bodyIntro,
	enabled: organizationMailTemplate.enabled,
} as const;

/**
 * The best override for a template: the requested language if present, else the org's default
 * (`en`). Returns `null` when the org has overridden neither.
 */
export async function readMailTemplate(
	db: AdminDatabase,
	organizationId: string,
	templateKey: string,
	language: string,
): Promise<MailTemplateRow | null> {
	const rows = await db
		.select(COLUMNS)
		.from(organizationMailTemplate)
		.where(
			and(
				eq(organizationMailTemplate.organizationId, organizationId),
				eq(organizationMailTemplate.templateKey, templateKey),
			),
		);
	const enabled = rows.filter((row) => row.enabled);
	return (
		enabled.find((row) => row.language === language) ??
		enabled.find((row) => row.language === "en") ??
		null
	);
}

/** Every override an organization has set, for the management surface. */
export async function listMailTemplates(
	db: AdminDatabase,
	organizationId: string,
): Promise<readonly MailTemplateRow[]> {
	return await db
		.select(COLUMNS)
		.from(organizationMailTemplate)
		.where(eq(organizationMailTemplate.organizationId, organizationId));
}

/** Upsert one (template, language) override for an organization. */
export async function upsertMailTemplate(
	db: AdminDatabase,
	input: {
		readonly organizationId: string;
		readonly templateKey: string;
		readonly language: string;
		readonly subject?: string | null;
		readonly bodyIntro?: string | null;
		readonly enabled?: boolean;
	},
): Promise<MailTemplateRow> {
	const set: Record<string, unknown> = {};
	if (input.subject !== undefined) set.subject = input.subject;
	if (input.bodyIntro !== undefined) set.bodyIntro = input.bodyIntro;
	if (input.enabled !== undefined) set.enabled = input.enabled;

	const rows = await db
		.insert(organizationMailTemplate)
		.values({
			organizationId: input.organizationId,
			templateKey: input.templateKey,
			language: input.language,
			subject: input.subject ?? null,
			bodyIntro: input.bodyIntro ?? null,
			enabled: input.enabled ?? true,
		})
		.onConflictDoUpdate({
			target: [
				organizationMailTemplate.organizationId,
				organizationMailTemplate.templateKey,
				organizationMailTemplate.language,
			],
			set: Object.keys(set).length > 0 ? set : { language: input.language },
		})
		.returning(COLUMNS);
	return rows[0]!;
}
