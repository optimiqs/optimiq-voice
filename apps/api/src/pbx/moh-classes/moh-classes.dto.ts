import { z } from "zod/v4";
import { MOH_SOURCES } from "@optimiq-voice/pbx-db";
import { displayName, resettable } from "../shared/dto";

/**
 * A music-on-hold class.
 *
 * `source` is the one field with a consequence beyond bookkeeping. `"library"` means the class
 * plays the audio files uploaded under it; `"stream"` means the media server pulls a continuous
 * Icecast/HTTP source and the files are ignored. The two are mutually exclusive at play time, so a
 * `stream` class with no `streamUri` is refused here rather than left to fail silently on a call —
 * that is the same rule the area applies to a destination trio, and for the same reason.
 *
 * The reverse case is deliberately NOT refused: a `library` class with a `streamUri` is allowed,
 * because switching a class back and forth between the two while keeping the URI on the row is a
 * normal thing to do and losing the URI on every switch would be hostile.
 *
 * `name` is what reaches the media server (see `moh-classes.resource.ts`), so it is constrained to
 * what a media server will accept as a class name: it lands in `musiconhold.conf` as a section
 * name, and a section name with a `]` or a newline in it is a configuration file that does not
 * parse. Letters, digits, dash, underscore and dot — the same alphabet every PBX has used for this
 * since the beginning.
 */
const MOH_CLASS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const mohClassName = displayName
	.max(64)
	.regex(
		MOH_CLASS_NAME,
		"must start with a letter or digit and contain only letters, digits, dot, dash or underscore — " +
			"it becomes a class name in the media server's configuration",
	);

/**
 * The stream URI, constrained the way {@link mohClassName} is and for the same reason.
 *
 * The URI lands on a line of `musiconhold.conf` right beside the section name, and it is passed to
 * `application=`, which `res_musiconhold` runs as a COMMAND on the media server. Free text there is
 * not a formatting problem, it is remote command execution: a newline ends the comment line and
 * starts an attacker-chosen `application=`, a `]` forges a section, and a `;` or `#` truncates.
 * So: an http/https URL, nothing else, spelled as an ALLOWLIST — a list of forbidden characters is
 * one omission away from an escape, and the set a URL actually needs is small.
 */
const MOH_STREAM_URI = /^https?:\/\/[A-Za-z0-9._~:/?@!$&()*+,=%-]+$/u;

export const mohStreamUri = z
	.string()
	.trim()
	.max(512)
	.refine(
		(value) => MOH_STREAM_URI.test(value),
		"must be an http:// or https:// URL with no whitespace, quotes or shell metacharacters — " +
			"it becomes a command argument in the media server's configuration",
	);

export const createMohClassDto = z
	.strictObject({
		name: mohClassName,
		description: z.string().max(512).nullish(),
		source: z.enum(MOH_SOURCES).optional(),
		/** Icecast/HTTP URI when `source = "stream"`. */
		streamUri: mohStreamUri.nullish(),
		shuffle: z.boolean().optional(),
		/**
		 * The rate the media server is told to expect. 8000 is what needs no conversion anywhere in
		 * the stack; the other two are the rates a wideband deployment actually uses.
		 */
		sampleRateHz: resettable(z.union([z.literal(8000), z.literal(16_000), z.literal(48_000)])),
		isDefault: z.boolean().optional(),
		enabled: z.boolean().optional(),
	})
	.superRefine((value, context) => {
		if (
			value.source === "stream" &&
			(value.streamUri === undefined || value.streamUri === null || value.streamUri === "")
		) {
			context.addIssue({
				code: "custom",
				path: ["streamUri"],
				message: "a streaming class needs the URI the media server should pull",
			});
		}
	});

/**
 * The patch.
 *
 * `patchOf` cannot be used: it takes a `ZodObject`, and the create schema above is a
 * `ZodEffects`-shaped refinement rather than a bare object. The refinement is re-stated instead of
 * dropped, because a PATCH that switched `source` to `"stream"` without a URI would be exactly the
 * write the create schema refuses — and the merged row is not available here, so the rule is
 * applied to what the caller SENT: naming `stream` in a patch means naming the URI in the same
 * patch, which is what a form does anyway.
 */
export const updateMohClassDto = z
	.strictObject({
		name: mohClassName.optional(),
		description: z.string().max(512).nullish(),
		source: z.enum(MOH_SOURCES).optional(),
		streamUri: mohStreamUri.nullish(),
		shuffle: z.boolean().optional(),
		sampleRateHz: resettable(z.union([z.literal(8000), z.literal(16_000), z.literal(48_000)])),
		isDefault: z.boolean().optional(),
		enabled: z.boolean().optional(),
	})
	.superRefine((value, context) => {
		if (
			value.source === "stream" &&
			(value.streamUri === undefined || value.streamUri === null || value.streamUri === "")
		) {
			context.addIssue({
				code: "custom",
				path: ["streamUri"],
				message: "a streaming class needs the URI the media server should pull",
			});
		}
	});
