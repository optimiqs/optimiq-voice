import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

/**
 * Zod validation schema for the Create Credential form.
 *
 * Defines the expected structure and validation rules for the credential creation fields.
 * Fields include:
 * - ref: Optional string reference ID.
 * - name: Required string, cannot be empty (friendly name).
 * - username: Required string, cannot be empty (username).
 * - password: Optional password field validated by PASSWORD_SCHEMA.
 */
export const schema = z.object({
	/** Unique identifier for the credential (optional). */
	ref: z.string().nullish(),

	/** Human-friendly name for the credential (required). */
	name: z.string().nonempty("Friendly Name is required"),

	/** Username associated with the credential (required). */
	username: z.string().nonempty("Username is required"),

	/** Password field validated by PASSWORD_SCHEMA (optional). */
	password: z.string().nonempty(),
});

/**
 * Type representing the validated data structure returned by the schema.
 *
 * This type is useful for typing the form state, handlers, and submissions.
 */
export type Schema = z.infer<typeof schema>;
