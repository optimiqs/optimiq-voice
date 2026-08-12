import { z } from "zod/v4";
import { DIRECTORY_SEARCH_FIELDS } from "@optimiq-voice/pbx-db";
import {
	destinationShape,
	displayName,
	internalNumber,
	namedDestinationShape,
	patchOf,
	resettable,
	shortCode,
} from "../shared/dto";

const destinationAliasShape = {
	name: displayName,
	description: z.string().max(512).nullish(),
	...destinationShape(true),
	enabled: z.boolean().optional(),
};

export const createDestinationAliasDto = z.strictObject(destinationAliasShape);

export const updateDestinationAliasDto = patchOf(z.strictObject(destinationAliasShape));

/**
 * The stream URL's allow-list is a SECURITY check, not formatting.
 *
 * The set of things a tenant may cause the media server to open is a decision about what the media
 * server will read — `file:///etc/passwd` is a URL — so it is refused at the edge as a 400 naming
 * the field, and re-checked by the compiler because the snapshot is data rather than a database.
 * Two checks that agree, in the two places the value can arrive from.
 */
const audioStreamShape = {
	name: displayName,
	description: z.string().max(512).nullish(),
	url: z
		.url()
		.max(1024)
		.refine(
			(value) => value.startsWith("http://") || value.startsWith("https://"),
			"must be an http or https URL",
		),
	answerFirst: z.boolean().optional(),
	/** Zero means "until the caller hangs up", which is what an always-on radio feed wants. */
	maxSeconds: resettable(z.int().min(0).max(86_400)),
	...namedDestinationShape("fallback"),
	enabled: z.boolean().optional(),
};

export const createAudioStreamDto = z.strictObject(audioStreamShape);

export const updateAudioStreamDto = patchOf(z.strictObject(audioStreamShape));

const dialByNameDirectoryShape = {
	name: displayName,
	extensionNumber: internalNumber.nullish(),
	searchField: z.enum(DIRECTORY_SEARCH_FIELDS).optional(),
	/**
	 * Two at the bottom because a two-letter surname exists; six at the top because past that the
	 * caller is spelling the whole name, which is the interaction a directory exists to avoid.
	 */
	minDigits: resettable(z.int().min(2).max(6)),
	greetingPromptId: z.uuid().nullish(),
	invalidPromptId: z.uuid().nullish(),
	maxFailures: resettable(z.int().min(1).max(10)),
	...namedDestinationShape("timeout"),
	enabled: z.boolean().optional(),
};

export const createDialByNameDirectoryDto = z.strictObject(dialByNameDirectoryShape);

export const updateDialByNameDirectoryDto = patchOf(z.strictObject(dialByNameDirectoryShape));

/**
 * An organization speed dial.
 *
 * `code` accepts both `*01` and `8001` — the compiler is what screens either shape against the
 * feature-code catalogue and the internal numbers, because those collisions are facts about the
 * whole tenant rather than about this row.
 */
const speedDialShape = {
	code: shortCode,
	label: displayName,
	...destinationShape(true),
	enabled: z.boolean().optional(),
};

export const createSpeedDialDto = z.strictObject(speedDialShape);

export const updateSpeedDialDto = patchOf(z.strictObject(speedDialShape));
