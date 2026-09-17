import { describe, expect, it } from "bun:test";
import {
	NETWORK_SHAPE_MESSAGE,
	ipv4HasHostBits,
	networkIssue,
	normalizeNetwork,
	parseNetwork,
} from "./cidr";

/**
 * `cidr.ts` MIRRORS `apps/api/src/pbx/security/sip-acl.dto.ts` rather than importing it — the DTO
 * lives in a Nest application rather than in a workspace package — so what needs proving here is
 * the mirror: the same values the server pre-filters out, refused with the same sentences, and the
 * same normalisation applied before the body is sent.
 *
 * The stakes are not cosmetic. A value this file lets through that PostgreSQL then refuses arrives
 * as a `22P02`, which the API area has no domain failure for and which therefore renders as a 503 —
 * "the service is unavailable" shown to somebody who mistyped a prefix. A value this file refuses
 * that PostgreSQL would have accepted is worse: an administrator who cannot enter a legitimate
 * network has no way around the control at all.
 */

describe("parseNetwork", () => {
	it("reads an IPv4 network and its prefix", () => {
		expect(parseNetwork("203.0.113.0/24")).toEqual({
			family: 4,
			address: "203.0.113.0",
			prefix: 24,
		});
	});

	/**
	 * A bare address is the single host, which is what an administrator means by "allow this one
	 * server". Requiring the suffix would be pedantry with a 400 attached — the server's own words.
	 */
	it("defaults a bare address to the host prefix of its family", () => {
		expect(parseNetwork("198.51.100.7")?.prefix).toBe(32);
		expect(parseNetwork("2001:db8::1")?.prefix).toBe(128);
	});

	it("reads an IPv6 network", () => {
		expect(parseNetwork("2001:db8::/32")).toEqual({
			family: 6,
			address: "2001:db8::",
			prefix: 32,
		});
	});

	/**
	 * The IPv6 test is a colon test on top of a hex-characters test, and both halves matter: `dead`
	 * is valid hexadecimal and is not an address, while `::1` is four characters and is one.
	 */
	it("requires a colon before calling something IPv6", () => {
		expect(parseNetwork("dead")).toBeUndefined();
		expect(parseNetwork("::1")?.family).toBe(6);
	});

	it("refuses a prefix beyond the family's ceiling", () => {
		expect(parseNetwork("10.0.0.0/33")).toBeUndefined();
		expect(parseNetwork("10.0.0.0/32")?.prefix).toBe(32);
		expect(parseNetwork("2001:db8::/129")).toBeUndefined();
		expect(parseNetwork("2001:db8::/128")?.prefix).toBe(128);
		expect(parseNetwork("10.0.0.0/0")?.prefix).toBe(0);
	});

	it("refuses a suffix that is not a number", () => {
		expect(parseNetwork("10.0.0.0/24a")).toBeUndefined();
		expect(parseNetwork("10.0.0.0/")).toBeUndefined();
		expect(parseNetwork("10.0.0.0/ 24")).toBeUndefined();
	});

	it("refuses an octet above 255", () => {
		expect(parseNetwork("10.0.0.256/24")).toBeUndefined();
		expect(parseNetwork("10.0.0")).toBeUndefined();
	});

	/** `lastIndexOf` rather than `indexOf`, so a v6 address with no prefix is not split on nothing. */
	it("splits on the LAST slash, which is the only one a network can carry", () => {
		expect(parseNetwork("2001:db8::/32/24")).toBeUndefined();
	});
});

describe("ipv4HasHostBits", () => {
	/**
	 * The whole point of the file. `cidr` refuses a value with bits set to the right of the mask —
	 * `10.0.0.1/24` is an error, not a silent truncation — and it is also the single most common
	 * thing an administrator gets wrong, because it is exactly what they would type after reading an
	 * address off a router.
	 */
	it("catches the mistake an administrator actually makes", () => {
		expect(ipv4HasHostBits("10.0.0.1", 24)).toBe(true);
		expect(ipv4HasHostBits("10.0.0.0", 24)).toBe(false);
		expect(ipv4HasHostBits("203.0.113.128", 25)).toBe(false);
		expect(ipv4HasHostBits("203.0.113.129", 25)).toBe(true);
	});

	/** `/32` is one host, so every bit is inside the mask and nothing can be below it. */
	it("never complains about a host route", () => {
		expect(ipv4HasHostBits("198.51.100.7", 32)).toBe(false);
	});

	/**
	 * `/0` is the default route and the special case the shift arithmetic gets wrong if written
	 * naively: `0xffffffff << 32` is `0xffffffff`, not zero.
	 */
	it("treats /0 as a mask with no bits at all", () => {
		expect(ipv4HasHostBits("0.0.0.0", 0)).toBe(false);
		expect(ipv4HasHostBits("10.0.0.1", 0)).toBe(true);
	});

	/** The top bit is set, so the packed value is negative until it is coerced back. */
	it("handles addresses above 127 in the first octet", () => {
		expect(ipv4HasHostBits("192.168.0.0", 16)).toBe(false);
		expect(ipv4HasHostBits("192.168.0.1", 16)).toBe(true);
		expect(ipv4HasHostBits("255.255.255.255", 32)).toBe(false);
	});
});

describe("networkIssue", () => {
	it("accepts the forms the column accepts", () => {
		expect(networkIssue("203.0.113.0/24")).toBeUndefined();
		expect(networkIssue("198.51.100.7")).toBeUndefined();
		expect(networkIssue("2001:db8::/32")).toBeUndefined();
		expect(networkIssue("  203.0.113.0/24  ")).toBeUndefined();
	});

	/** The message says what to write instead, because "invalid" leaves the user nowhere to go. */
	it("names the boundary and the way out when host bits are set", () => {
		expect(networkIssue("10.0.0.1/24")).toBe(
			"10.0.0.1/24 has bits set below the /24 boundary — write the network address, or use a /32 for a single host",
		);
	});

	it("falls back to the shape sentence for anything unparseable", () => {
		expect(networkIssue("10.0.0.0/33")).toBe(NETWORK_SHAPE_MESSAGE);
		expect(networkIssue("not-an-address")).toBe(NETWORK_SHAPE_MESSAGE);
		expect(networkIssue("10.0.0.256")).toBe(NETWORK_SHAPE_MESSAGE);
	});

	it("reports an empty control and an overlong one separately", () => {
		expect(networkIssue("")).toBe("Required");
		expect(networkIssue("   ")).toBe("Required");
		expect(networkIssue("203.0.113.0/24".padEnd(65, "0"))).toBe("At most 64 characters");
	});

	/**
	 * IPv6 host bits are deliberately NOT checked, exactly as the server does not check them: the
	 * address forms are too varied for a comparison that would be right more often than the column
	 * is, and PostgreSQL refuses the bad ones with the field named. `2001:db8::1/32` therefore
	 * reaches the server, which is the correct behaviour rather than a gap.
	 */
	it("lets an IPv6 value with host bits through to the real parser", () => {
		expect(networkIssue("2001:db8::1/32")).toBeUndefined();
	});

	/**
	 * Neither routability nor scope is this file's decision. An allow entry for the loopback is
	 * meaningless and harmless; a deny entry for `0.0.0.0/0` is meaningful and drastic, and refusing
	 * it would remove the only way to express "allowlist only".
	 */
	it("says nothing about the loopback or the default route", () => {
		expect(networkIssue("127.0.0.1/32")).toBeUndefined();
		expect(networkIssue("127.0.0.1")).toBeUndefined();
		expect(networkIssue("0.0.0.0/0")).toBeUndefined();
		expect(networkIssue("::/0")).toBeUndefined();
	});
});

describe("normalizeNetwork", () => {
	/**
	 * `198.51.100.7` and `198.51.100.7/32` are ONE row after PostgreSQL widens them, so sending the
	 * raw spelling is how a form produces a 409 on a value it believes it has never seen.
	 */
	it("spells a bare address with the prefix that means one host", () => {
		expect(normalizeNetwork("198.51.100.7")).toBe("198.51.100.7/32");
		expect(normalizeNetwork("  198.51.100.7  ")).toBe("198.51.100.7/32");
		expect(normalizeNetwork("2001:db8::1")).toBe("2001:db8::1/128");
	});

	it("leaves a value that already carries a prefix alone", () => {
		expect(normalizeNetwork("203.0.113.0/24")).toBe("203.0.113.0/24");
		expect(normalizeNetwork("2001:db8::/32")).toBe("2001:db8::/32");
	});

	/**
	 * An unparseable value is passed through rather than mangled: `networkIssue` has already
	 * refused it, and inventing a prefix for a string that is not an address would put a value on
	 * the wire that nobody typed.
	 */
	it("passes an unparseable value through untouched", () => {
		expect(normalizeNetwork("not-an-address")).toBe("not-an-address");
		expect(normalizeNetwork("")).toBe("");
	});
});
