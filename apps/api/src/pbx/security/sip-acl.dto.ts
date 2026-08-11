import { z } from "zod/v4";
import { SIP_ACL_ACTIONS, SIP_ACL_SCOPES } from "@optimiq-voice/pbx-db";
import { patchOf } from "../shared/dto";

/**
 * A CIDR access-control entry.
 *
 * ## Why the network is validated here and not left to Postgres
 *
 * The column is a native `cidr`, so the database is the authority on what a network is and it
 * normalises what it accepts. Left alone, though, a malformed value arrives as a `22P02`
 * (`invalid_text_representation`) — a class of error this layer has no domain failure for and which
 * therefore renders as a 503. "The service is unavailable" is the wrong sentence to show somebody
 * who typed `10.0.0.0/33`. So the shape is checked at the edge, the same argument
 * `park-lots.dto.ts` makes for its slot range, and Postgres remains the authority on everything
 * subtler.
 *
 * ## The host-bits rule, which is the one that catches real mistakes
 *
 * `cidr` refuses a value with bits set to the right of the mask: `10.0.0.1/24` is an error, not a
 * silent truncation to `10.0.0.0/24`. That refusal is correct and it is also the single most common
 * thing an administrator gets wrong, because it is exactly what they would type when reading an
 * address off a router. It is checked here so the message can say what to write instead.
 *
 * A bare address with no prefix is accepted and means the single host: `/32` for IPv4, `/128` for
 * IPv6. That is what an administrator means by "allow this one server", and requiring the suffix
 * would be pedantry with a 400 attached.
 *
 * ## What is deliberately NOT validated
 *
 * That the network is routable, public, or not the loopback. An allow entry for `127.0.0.1/32` is
 * meaningless and harmless; a deny entry for `0.0.0.0/0` is meaningful and drastic, and refusing it
 * would remove the only way to express "allowlist only". Neither is this schema's decision.
 */

/** IPv4 dotted quad, each octet 0–255. */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/u;

/**
 * IPv6, including the `::` compressed forms and the v4-mapped tail.
 *
 * Deliberately permissive rather than exhaustive: this is a pre-filter whose job is to turn an
 * obvious typo into a 400 and let everything plausible through to the column, which is the real
 * parser. A regex that tried to be the authority on RFC 4291 would be the thing that refused a
 * legitimate address.
 */
const IPV6 = /^[0-9A-Fa-f:]{2,45}$/u;

interface ParsedNetwork {
	readonly family: 4 | 6;
	readonly address: string;
	readonly prefix: number;
}

function parseNetwork(value: string): ParsedNetwork | undefined {
	const slash = value.lastIndexOf("/");
	const address = slash === -1 ? value : value.slice(0, slash);
	const suffix = slash === -1 ? undefined : value.slice(slash + 1);

	const family = IPV4.test(address)
		? 4
		: IPV6.test(address) && address.includes(":")
			? 6
			: undefined;
	if (family === undefined) {
		return undefined;
	}

	const maxPrefix = family === 4 ? 32 : 128;
	if (suffix === undefined) {
		return { family, address, prefix: maxPrefix };
	}
	if (!/^\d{1,3}$/u.test(suffix)) {
		return undefined;
	}
	const prefix = Number(suffix);
	if (prefix > maxPrefix) {
		return undefined;
	}
	return { family, address, prefix };
}

/** Whether an IPv4 address has any bit set to the right of `prefix`. Postgres refuses those. */
function ipv4HasHostBits(address: string, prefix: number): boolean {
	const octets = address.split(".").map(Number);
	const packed =
		((octets[0] ?? 0) << 24) |
		((octets[1] ?? 0) << 16) |
		((octets[2] ?? 0) << 8) |
		(octets[3] ?? 0);
	if (prefix === 0) {
		return packed !== 0;
	}
	// `>>> 0` because the shift result is signed and `0xffffffff << 0` is -1.
	const mask = (0xff_ff_ff_ff << (32 - prefix)) >>> 0;
	return ((packed >>> 0) & ~mask) >>> 0 !== 0;
}

const network = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.superRefine((value, context) => {
		const parsed = parseNetwork(value);
		if (parsed === undefined) {
			context.addIssue({
				code: "custom",
				message:
					"must be a CIDR network such as 203.0.113.0/24, 2001:db8::/32, or a bare address " +
					"for a single host",
			});
			return;
		}
		if (parsed.family === 4 && ipv4HasHostBits(parsed.address, parsed.prefix)) {
			context.addIssue({
				code: "custom",
				message:
					`${value} has bits set below the /${parsed.prefix} boundary — write the network ` +
					"address, or use a /32 for a single host",
			});
		}
	})
	// Normalised so a bare address and its /32 are one row rather than two that collide on the
	// unique index only after Postgres has widened them.
	.transform((value) => {
		const parsed = parseNetwork(value);
		return parsed === undefined || value.includes("/") ? value : `${value}/${parsed.prefix}`;
	});

const sipAclEntryShape = {
	/** What an administrator calls this rule: "HQ office", "Telnyx signalling". */
	name: z.string().trim().min(1).max(128).nullish(),
	network,
	action: z.enum(SIP_ACL_ACTIONS).optional(),
	/**
	 * Which surface the rule guards.
	 *
	 * Not defaulted here even though the column defaults to `registration`: a caller that omitted
	 * the scope almost certainly did not mean "the one that governs whether phones can register",
	 * and the column default exists for rows written by a migration, not by a form.
	 */
	scope: z.enum(SIP_ACL_SCOPES),
	/** Lower wins. Ties are broken by the longer prefix. */
	priority: z.int().min(0).max(10_000).optional(),
	description: z.string().trim().max(512).nullish(),
	enabled: z.boolean().optional(),
};

export const createSipAclEntryDto = z.strictObject(sipAclEntryShape);
export const updateSipAclEntryDto = patchOf(z.strictObject(sipAclEntryShape));

/** Exported for the renderer's tests, which need the same notion of a well-formed network. */
export const parseAclNetwork = parseNetwork;
