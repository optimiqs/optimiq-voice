import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Role } from "@optimiq-voice/types";

/**
 * Zod validation schema for the Create API Key form.
 *
 * Defines the expected structure and validation rules for the apiKey creation fields.
 * Fields include:
 * - ref: Optional string reference ID.
 * - role: Required string representing the apiKey's role.
 */
export const schema = z.object({
	/** Unique identifier for the apiKey (optional). */
	ref: z.string().nullish(),

	/** Human-friendly name for the apiKey (required). */
	role: z.nativeEnum(Role),
});

/**
 * Type representing the validated data structure returned by the schema.
 *
 * This type is useful for typing the form state, handlers, and submissions.
 */
export type Schema = z.infer<typeof schema>;
