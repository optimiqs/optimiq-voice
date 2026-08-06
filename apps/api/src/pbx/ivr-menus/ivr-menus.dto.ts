import { z } from "zod/v4";
import { IVR_OPTION_MATCH_KINDS } from "@optimiq-voice/pbx-db";
import {
	destinationShape,
	displayName,
	internalNumber,
	namedDestinationShape,
	patchOf,
} from "../shared/dto";

export const createIvrMenuDto = z.strictObject({
	name: displayName,
	/** Optional internal number so staff can dial the menu directly. */
	extensionNumber: internalNumber.nullish(),
	parentId: z.uuid().nullish(),
	greetingPromptId: z.uuid().nullish(),
	shortGreetingPromptId: z.uuid().nullish(),
	invalidPromptId: z.uuid().nullish(),
	timeoutPromptId: z.uuid().nullish(),
	digitTimeoutMs: z.int().min(500).max(60_000).optional(),
	interDigitTimeoutMs: z.int().min(200).max(30_000).optional(),
	maxDigits: z.int().min(1).max(10).optional(),
	maxFailures: z.int().min(1).max(10).optional(),
	maxTimeouts: z.int().min(1).max(10).optional(),
	/** Allow callers to dial an extension number that is not an explicit option. */
	directDialEnabled: z.boolean().optional(),
	...namedDestinationShape("timeout"),
	...namedDestinationShape("invalid"),
	enabled: z.boolean().optional(),
});

export const updateIvrMenuDto = patchOf(createIvrMenuDto);

export const createIvrMenuOptionDto = z.strictObject({
	ordinal: z.int().min(0).max(1000),
	matchKind: z.enum(IVR_OPTION_MATCH_KINDS).optional(),
	/** A single digit (`1`, `*`, `#`) or a POSIX regex, per `matchKind`. */
	matchValue: z.string().min(1).max(64),
	label: z.string().max(128).nullish(),
	...destinationShape(true),
	enabled: z.boolean().optional(),
});

export const updateIvrMenuOptionDto = patchOf(createIvrMenuOptionDto);
