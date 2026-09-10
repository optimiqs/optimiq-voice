import { z } from "zod/v4";
import { KYC_DECISIONS, KYC_ENTITY_TYPES } from "@optimiq-voice/pbx-db";

/**
 * The know-your-customer file, as a tenant may write it.
 *
 * ## What is absent, and why the absence is the security property
 *
 * `decision`, `reviewedBy`, `reviewedAt` and `reviewNotes` are not in this schema and never will
 * be. They are facts a **platform reviewer** asserted about the tenant, and accepting any of them
 * from a tenant's request body would let the subject of a compliance review write its own verdict —
 * which is not a validation bug but the whole regulatory apparatus failing at once. The same
 * argument `emergency-addresses.dto.ts` makes for `validated` ("a `validated: true` from a request
 * body would let anyone with `numbers.emergency` mark an unverified address as verified"), applied
 * to a field with a reviewer's name on it.
 *
 * The schema is `strictObject`, so those four names are not silently dropped — they are a 400. A
 * client that thinks it can set a decision should find that out loudly.
 *
 * ## The validation is shallow, on purpose, and for a different reason than E911's
 *
 * There is no tax-id format check, no address validation, no company-registry lookup. Not because
 * an authority will validate it later — nothing here calls one — but because this file is a
 * **statement the tenant made**, and its value to a traceback comes from being on the record with
 * a timestamp and a reviewer, not from having passed a regex. A `taxId` refused because this API's
 * idea of an EIN disagrees with a Portuguese NIF would block onboarding for a real company; a
 * reviewer reading the file catches what a pattern cannot. Length bounds and non-emptiness are the
 * whole of it.
 *
 * ## `taxId` goes in and never comes back
 *
 * Writable here, never present in any response. See `kyc.repository.ts` for the envelope, and
 * `KYC_RESPONSE_COLUMNS` for the read projection that enforces it. `taxIdLast4` is the readable
 * half: enough for a reviewer to confirm they are looking at the right file over the phone, and
 * useless to anyone who obtains the row.
 */
const line = z.string().trim().min(1).max(128);

export const upsertKycDto = z.strictObject({
	legalEntityName: line,
	entityType: z.enum(KYC_ENTITY_TYPES),
	/**
	 * The tax identifier, encrypted at rest and never returned.
	 *
	 * `nullish` rather than required: a sole proprietor in some jurisdictions genuinely has none,
	 * and an onboarding form that cannot be submitted without one is an onboarding form that gets
	 * a made-up number typed into it — which is worse than an empty column, because it looks filled.
	 * Passing `null` explicitly CLEARS the stored value and its last-4; omitting the key leaves both
	 * untouched, which is what lets a client PUT the file back without having to re-send a secret it
	 * has never been able to read.
	 */
	taxId: z.string().trim().min(1).max(64).nullish(),

	addressLine1: line,
	addressLine2: z.string().trim().max(128).nullish(),
	addressCity: line,
	addressRegion: z.string().trim().max(128).nullish(),
	addressPostalCode: z.string().trim().max(32).nullish(),
	addressCountry: z
		.string()
		.trim()
		.length(2, "must be an ISO 3166-1 alpha-2 country code, e.g. US")
		.regex(/^[A-Za-z]{2}$/u, "must be two letters")
		.transform((value) => value.toUpperCase()),

	contactName: line,
	contactEmail: z.email().max(254),
	contactPhone: z.string().trim().max(32).nullish(),
	websiteUrl: z.url().max(512).nullish(),

	/**
	 * What the tenant says it will send — the "expected traffic" half of a KYC file.
	 *
	 * Free text and not an enum, deliberately. The regulatory question is "did you ask, and what did
	 * they say", and an enum would replace the answer with the nearest option this codebase thought
	 * of in 2026. A reviewer reads it; nothing else does.
	 */
	expectedTrafficProfile: z.string().trim().max(1024).nullish(),
	expectedMonthlyMinutes: z.int().min(0).max(1_000_000_000).nullish(),
});

export type UpsertKycDto = z.infer<typeof upsertKycDto>;

/**
 * A platform reviewer's verdict.
 *
 * `reviewedBy` is NOT here either, for the mirror of the reason it is absent from {@link upsertKycDto}:
 * the acting operator is read from the session, once, at the service layer — exactly as
 * `PbxResourceService` derives its audit actor — because a reviewer id accepted from a body is a
 * reviewer id that can name somebody else.
 */
export const kycDecisionDto = z.strictObject({
	decision: z.enum(KYC_DECISIONS),
	/**
	 * Why. Optional on an approval, and that asymmetry is not enforced here.
	 *
	 * A `rejected` with no note is a bad review, not an invalid request, and refusing it would only
	 * teach reviewers to type "no". The admin UI marks it required for `rejected` and `needs-info`,
	 * which is where a nudge belongs.
	 */
	reviewNotes: z.string().trim().max(4096).nullish(),
});

export type KycDecisionDto = z.infer<typeof kycDecisionDto>;

/** The platform review queue's filter. Paged with page/limit, like every other admin listing. */
export const platformKycListQuerySchema = z.object({
	decision: z.enum(KYC_DECISIONS).optional(),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PlatformKycListQuery = z.infer<typeof platformKycListQuerySchema>;
