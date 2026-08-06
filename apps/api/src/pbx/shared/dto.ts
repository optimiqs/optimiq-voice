import { BadRequestException, HttpStatus } from "@nestjs/common";
import { z } from "zod/v4";
import { DESTINATION_TYPES } from "@optimiq-voice/pbx-db";

/**
 * DTO validation at the edge.
 *
 * `apps/api` has no global `ValidationPipe` (its legacy surface is gRPC-shaped), so the PBX
 * controllers parse explicitly with Zod and this is the one place that turns a parse failure into
 * an HTTP body. The shape matches the rest of the area's errors — a `code` a client can switch on
 * plus per-field issues — so a form can attach every message to its input in one pass:
 *
 * ```jsonc
 * { "statusCode": 400, "code": "PBX_INVALID_BODY", "message": "…",
 *   "issues": [{ "field": "number", "code": "too_small", "message": "…" }] }
 * ```
 *
 * `z.strictObject` everywhere: an unknown key is a client that thinks it is setting something.
 * Silently dropping it is how "I set recordEnabled and it did nothing" bugs are born.
 */
export function parseDto<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
	const result = schema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new BadRequestException({
		statusCode: HttpStatus.BAD_REQUEST,
		code: "PBX_INVALID_BODY",
		message: result.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; "),
		issues: result.error.issues.map((issue) => ({
			field: issue.path.join("."),
			code: issue.code,
			message: issue.message,
		})),
	});
}

/**
 * `PATCH` semantics.
 *
 * A key that is absent is "leave it alone"; a key present as `null` is "clear it". Zod's
 * `.partial()` gives exactly that distinction, and the repository writes only the keys it is
 * handed — so a partial update never resurrects a default over a value the user set.
 */
export function patchOf<T extends z.ZodObject>(schema: T): z.ZodObject {
	return schema.partial();
}

// ---------------------------------------------------------------------------------------------
// Shared field shapes
// ---------------------------------------------------------------------------------------------

export const destinationTypeEnum = z.enum(DESTINATION_TYPES);

export const destinationDataDto = z
	.strictObject({
		value: z.string().min(1).max(256).optional(),
		args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
		cause: z.string().max(64).optional(),
	})
	.nullish();

/**
 * The three columns of one destination trio, named for the prefix that owns them.
 *
 * Returned as a spreadable shape rather than a nested object so the wire format matches the row:
 * `{ destinationType, destinationRef, destinationData }`, `{ timeoutDestinationType, … }`. A
 * nested `{ destination: { type, ref } }` would read better in isolation and would then need
 * flattening in every service, in both directions, for eleven resources.
 */
export function destinationShape(required = true) {
	return required
		? {
				destinationType: destinationTypeEnum,
				destinationRef: z.uuid().nullish(),
				destinationData: destinationDataDto,
			}
		: {
				destinationType: destinationTypeEnum.nullish(),
				destinationRef: z.uuid().nullish(),
				destinationData: destinationDataDto,
			};
}

/** A secondary trio, e.g. `timeout` -> `timeoutDestinationType` / `Ref` / `Data`. Always optional. */
export function namedDestinationShape<TPrefix extends string>(prefix: TPrefix) {
	return {
		[`${prefix}DestinationType`]: destinationTypeEnum.nullish(),
		[`${prefix}DestinationRef`]: z.uuid().nullish(),
		[`${prefix}DestinationData`]: destinationDataDto,
	} as {
		[K in `${TPrefix}DestinationType`]: z.ZodOptional<z.ZodNullable<typeof destinationTypeEnum>>;
	} & {
		[K in `${TPrefix}DestinationRef`]: z.ZodOptional<z.ZodNullable<z.ZodUUID>>;
	} & { [K in `${TPrefix}DestinationData`]: typeof destinationDataDto };
}

/** A dialable string: digits plus the characters a PBX actually dials. */
export const dialableString = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[+*#0-9A-Za-z._-]+$/u, "must be a dialable string");

/** E.164, `+` included — how every DID is stored. */
export const e164 = z
	.string()
	.min(2)
	.max(20)
	.regex(/^\+[1-9]\d{1,18}$/u, "must be E.164, e.g. +12125550100");

/** An internal number: digits only, no leading `*` (that space belongs to feature codes). */
export const internalNumber = z
	.string()
	.min(1)
	.max(16)
	.regex(/^[0-9]+$/u, "must be digits only");

export const displayName = z.string().trim().min(1).max(128);
