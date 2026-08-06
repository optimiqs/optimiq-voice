import { z } from "zod/v4";
import {
	DEVICE_KEY_CATEGORIES,
	DEVICE_KEY_TYPES,
	DEVICE_VENDORS,
	SIP_TRANSPORTS,
} from "@optimiq-voice/pbx-db";
import { displayName, patchOf, resettable } from "../../pbx/shared/dto";
import { normalizeMacAddress } from "../catalog/mac";

/**
 * Device DTOs.
 *
 * ## The MAC is normalized here, at the edge, and nowhere else
 *
 * `00:15:65:AB:CD:EF`, `0015.65ab.cdef` and `001565ABCDEF` are one address written three ways, and
 * an administrator will paste whichever their vendor's label printer chose. Normalizing in the DTO
 * means the column holds one spelling, `device_organization_mac_address_key` enforces uniqueness
 * over addresses rather than over spellings, and the render path's per-MAC filename lookup has
 * exactly one thing to compare against. Doing it in the service instead would leave the
 * uniqueness index one refactor away from being decorative.
 *
 * ## `settings` is an open record on purpose
 *
 * The vendor catalog knows which keys a given model understands, but the whole point of the
 * per-device override is to reach settings the catalog has not modelled — FusionPBX carried 947 of
 * them and this rebuild deliberately ships a curated fraction. A closed enum here would make the
 * escape hatch unusable, which is how administrators end up editing templates by hand. The values
 * are constrained to scalars (a nested object has no meaning in a `key = value` `.cfg`) and the
 * whole record is size-capped so a runaway paste cannot become a multi-megabyte JSONB row.
 */

/** A MAC in any spelling on the wire; twelve lower-case hex characters in the database. */
export const macAddressField = z
	.string()
	.trim()
	.min(12)
	.max(32)
	.transform((value, ctx) => {
		const normalized = normalizeMacAddress(value);
		if (normalized === undefined) {
			ctx.addIssue({
				code: "custom",
				message:
					"must be a 12-digit MAC address, with or without separators (e.g. 00:15:65:AB:CD:EF)",
			});
			return z.NEVER;
		}
		return normalized;
	});

/**
 * A free-form vendor settings bag.
 *
 * 128 keys and 1 KB per value: generous for any real override set (a fully-specified Yealink
 * deployment profile is a few dozen keys) and small enough that a thousand devices cannot make the
 * table unqueryable.
 */
export const provisioningSettingsField = z
	.record(z.string().min(1).max(128), z.union([z.string().max(1024), z.number(), z.boolean()]))
	.refine((value) => Object.keys(value).length <= 128, {
		message: "at most 128 settings",
	})
	.nullish();

export const createDeviceDto = z.strictObject({
	macAddress: macAddressField,
	vendor: z.enum(DEVICE_VENDORS).optional(),
	/**
	 * The model, matched against the catalog by the render path rather than by this DTO.
	 *
	 * Deliberately a free string and not an enum over the catalog: a deployment that buys a model
	 * released after this build must still be able to record what is on the desk, and the catalog
	 * falls back to the vendor's family template for a model it does not recognise. An enum would
	 * turn "we bought the new one" into "you cannot enter it".
	 */
	model: z.string().max(64).nullish(),
	label: displayName.nullish(),
	deviceProfileId: z.uuid().nullish(),
	settings: provisioningSettingsField,
	enabled: z.boolean().optional(),
});

/**
 * `provisioningToken`, `provisioningTokenHash`, `provisioningTokenExpiresAt`, `lastProvisionedAt`
 * and `lastProvisionedIp` are absent from both DTOs, and that is the security boundary.
 *
 * The first three are minted by `POST /devices/:id/provisioning-token` and never accepted from a
 * client: a form that could set a token could set a token an attacker already knows, and a form
 * that could set the hash could set the digest of one. The last two are the render path's record of
 * what actually happened, and an admin form that could write them would let somebody assert that a
 * phone checked in when it did not.
 */
export const updateDeviceDto = patchOf(createDeviceDto);

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

export const createDeviceLineDto = z.strictObject({
	/**
	 * Which key on the handset. 1-based because every vendor's documentation is, and capped at 64
	 * because that is more line keys than any phone plus its expansion modules has.
	 */
	lineNumber: z.int().min(1).max(64),
	extensionId: z.uuid().nullish(),
	authUser: z.string().max(128).nullish(),
	/** Handle into the secret manager. The password is derived from it, never stored. */
	sipSecretRef: z.string().max(256).nullish(),
	/** Overrides `PROVISION_SIP_SERVER` for this line, e.g. a branch with its own edge. */
	serverAddress: z.string().max(255).nullish(),
	serverPort: resettable(z.int().min(1).max(65_535)),
	transport: z.enum(SIP_TRANSPORTS).optional(),
	registerExpiresSeconds: resettable(z.int().min(30).max(86_400)),
	sharedLine: z.boolean().optional(),
	label: z.string().max(128).nullish(),
	enabled: z.boolean().optional(),
});

export const updateDeviceLineDto = patchOf(createDeviceLineDto);

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/**
 * A programmable key.
 *
 * `value` is interpreted by `keyType`: an extension number for `blf`, a dial string for
 * `speed-dial`, a URL for `url`, and nothing at all for `none` and `line`. The catalog's renderer
 * is what turns that into a vendor's numeric type code, because the mapping differs per vendor and
 * modelling it here would put five vendors' opinions in a DTO.
 */
export const createDeviceKeyDto = z.strictObject({
	category: z.enum(DEVICE_KEY_CATEGORIES).optional(),
	keyIndex: z.int().min(1).max(256),
	keyType: z.enum(DEVICE_KEY_TYPES).optional(),
	value: z.string().max(256).nullish(),
	label: z.string().max(64).nullish(),
	lineNumber: resettable(z.int().min(1).max(64)),
});

export const updateDeviceKeyDto = patchOf(createDeviceKeyDto);

// ---------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------

export const createDeviceProfileDto = z.strictObject({
	name: displayName,
	description: z.string().max(512).nullish(),
	vendor: z.enum(DEVICE_VENDORS).optional(),
	/** NULL means the profile applies to every model of `vendor`. */
	model: z.string().max(64).nullish(),
	settings: provisioningSettingsField,
	enabled: z.boolean().optional(),
});

export const updateDeviceProfileDto = patchOf(createDeviceProfileDto);

export const createDeviceProfileKeyDto = createDeviceKeyDto;
export const updateDeviceProfileKeyDto = patchOf(createDeviceProfileKeyDto);

// ---------------------------------------------------------------------------------------------
// Token rotation
// ---------------------------------------------------------------------------------------------

/**
 * Regenerating a provisioning token takes no body at all.
 *
 * Not even an "are you sure": the confirmation belongs in the UI, and a server that accepted a
 * `confirm: true` flag would be one whose safety depended on a client remembering to omit it.
 * `expiresInDays` is the one thing a caller may say, because a deployment that hands a token to a
 * contractor for one afternoon has a real reason to want it dead by evening.
 */
export const regenerateProvisioningTokenDto = z.strictObject({
	expiresInDays: z.int().min(0).max(3650).optional(),
});
