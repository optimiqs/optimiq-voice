/**
 * What the `network` column accepts, mirrored from `apps/api/src/pbx/security/sip-acl.dto.ts`.
 *
 * ## Why the client checks a value PostgreSQL is the authority on
 *
 * Because of what the database does with a bad one. `sip_acl_entry.network` is a native `cidr`, so
 * `10.0.0.0/33` arrives as a `22P02` — an error class the API area has no domain failure for, and
 * which therefore renders as a 503. "The service is unavailable" is the wrong sentence to show
 * somebody who mistyped a prefix, so the server pre-filters at the edge, and this file restates
 * that pre-filter so the message lands on the control instead of after a round trip.
 *
 * ## The host-bits rule is the one that catches real mistakes
 *
 * `cidr` refuses a value with bits set to the right of the mask — `10.0.0.1/24` is an error, not a
 * silent truncation to `10.0.0.0/24`. That refusal is correct, and it is also the single most
 * common thing an administrator gets wrong, because `10.0.0.1/24` is exactly what they would type
 * after reading an address off a router. The message therefore says what to write instead.
 *
 * ## What is deliberately NOT checked
 *
 * That the network is routable, public, or not the loopback. An allow entry for `127.0.0.1/32` is
 * meaningless and harmless; a deny entry for `0.0.0.0/0` is meaningful and drastic, and refusing it
 * would remove the only way to express "allowlist only". Neither is this file's decision, and the
 * screen says so next to the field rather than pretending the rule exists.
 */

/** IPv4 dotted quad, each octet 0–255. */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/u;

/**
 * IPv6, permissively.
 *
 * Deliberately not an RFC 4291 parser, and the server's is not either: this is a pre-filter whose
 * job is to turn an obvious typo into a message and let everything plausible reach the column,
 * which is the real parser. A regex that tried to be the authority here would be the thing that
 * refused a legitimate address.
 */
const IPV6 = /^[0-9A-Fa-f:]{2,45}$/u;

export interface ParsedNetwork {
	readonly family: 4 | 6;
	readonly address: string;
	/** The mask length. A bare address means the single host: `/32` or `/128`. */
	readonly prefix: number;
}

export function parseNetwork(value: string): ParsedNetwork | undefined {
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
export function ipv4HasHostBits(address: string, prefix: number): boolean {
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

export const NETWORK_SHAPE_MESSAGE =
	"must be a CIDR network such as 203.0.113.0/24, 2001:db8::/32, or a bare address for a single host";

/**
 * The problem with a network, or `undefined` when there is none.
 *
 * Returns the server's own sentences rather than paraphrases: a rule enforced in two places should
 * not be explained in two ways, or the message a user gets depends on whether the client happened
 * to catch it first.
 *
 * IPv6 host bits are not checked, exactly as the server does not check them — the address forms are
 * too varied for a comparison that would be right more often than the column is, and PostgreSQL
 * refuses the bad ones with the field named.
 */
export function networkIssue(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return "Required";
	}
	if (trimmed.length > 64) {
		return "At most 64 characters";
	}
	const parsed = parseNetwork(trimmed);
	if (parsed === undefined) {
		return NETWORK_SHAPE_MESSAGE;
	}
	if (parsed.family === 4 && ipv4HasHostBits(parsed.address, parsed.prefix)) {
		return (
			`${trimmed} has bits set below the /${String(parsed.prefix)} boundary — write the network ` +
			"address, or use a /32 for a single host"
		);
	}
	return undefined;
}

/**
 * A bare address, spelled with the prefix that means "this one host".
 *
 * Sent rather than the raw input for the reason the server normalises too: `198.51.100.7` and
 * `198.51.100.7/32` are one row, and letting both spellings through means a duplicate that only
 * collides on the unique index after PostgreSQL has widened them — a 409 on a value the form
 * believes it has never seen.
 */
export function normalizeNetwork(value: string): string {
	const trimmed = value.trim();
	const parsed = parseNetwork(trimmed);
	if (parsed === undefined || trimmed.includes("/")) {
		return trimmed;
	}
	return `${trimmed}/${String(parsed.prefix)}`;
}
