import { expect } from "chai";
import { byReversePrecedence, renderAclConf } from "../../src/pbx/security/acl-conf";
import type { SipAclRow } from "../../src/pbx/security/acl-conf";

/**
 * The `acl.conf` renderer.
 *
 * Golden-ish rather than byte-for-byte, on the terms `musicOnHoldConf.test.ts` states: the
 * assertions pin the lines a refusal cannot work without and deliberately not the whole document,
 * so adding a comment is an ordinary edit rather than a fixture rewrite nobody reads.
 *
 * The one property pinned exactly is the ORDER, because it is the only thing in this file that can
 * be plausibly and invisibly wrong. Asterisk applies ACL rules in sequence and the LAST match wins;
 * `sip_acl_entry` documents its own precedence as first-match-wins. Emitting the rows in the
 * table's order produces a file that parses perfectly and inverts every exception, which is a
 * security control that reads as configured and is backwards.
 */

const ORG_A = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const ORG_B = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

let seq = 0;

function aclRow(overrides: Partial<SipAclRow> = {}): SipAclRow {
	seq += 1;
	return {
		id: `019fd3c2-0000-76be-a6b3-${String(seq).padStart(12, "0")}`,
		organizationId: ORG_A,
		name: null,
		network: "203.0.113.0/24",
		action: "allow",
		scope: "registration",
		priority: 100,
		enabled: true,
		...overrides,
	};
}

function render(rows: readonly SipAclRow[]) {
	return renderAclConf(rows, { generatedAt: "2026-08-11T09:00:00.000Z" });
}

/** The rule lines of one section, comments and blanks stripped. */
function rulesOf(body: string, section: string): readonly string[] {
	const start = body.indexOf(`[${section}]`);
	expect(start, `section [${section}] is missing`).to.not.equal(-1);
	const rest = body.slice(start + section.length + 2);
	const end = rest.indexOf("\n[");
	return (end === -1 ? rest : rest.slice(0, end))
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith(";"));
}

describe("renderAclConf", () => {
	it("always declares every referenced section, so no named-ACL reference can dangle", () => {
		// A dangling reference in Asterisk is fail-OPEN: it logs once and filters nothing. Every
		// registering endpoint references [optimiq-registration] unconditionally and the carrier
		// wizard references [optimiq-trunk], so an empty table must still produce both sections.
		const result = render([]);
		for (const section of ["optimiq-registration", "optimiq-trunk"]) {
			expect(result.body).to.contain(`[${section}]`);
		}
		expect(result.sections.map((section) => section.mode)).to.deep.equal(["open", "open"]);
	});

	it("renders an empty table as permit-all, spelled out", () => {
		expect(rulesOf(render([]).body, "optimiq-registration")).to.deep.equal([
			"permit = 0.0.0.0/0.0.0.0",
			"permit = ::/0",
		]);
	});

	it("says at the top that it is generated, and how to apply it", () => {
		const result = render([aclRow()]);
		expect(result.body).to.contain("GENERATED FILE");
		expect(result.body).to.contain("generate:sip-acl");
		// The pjsip module, not `acl reload`: an endpoint caches the ACL object it resolved at load,
		// so refreshing the names alone leaves the endpoint filtering by the old rules, silently.
		expect(result.body).to.contain("module reload res_pjsip.so");
	});

	it("closes the list the moment one allow entry exists", () => {
		const rules = rulesOf(
			render([aclRow({ network: "203.0.113.0/24" })]).body,
			"optimiq-registration",
		);
		expect(rules[0]).to.equal("deny = 0.0.0.0/0.0.0.0");
		expect(rules[1]).to.equal("deny = ::/0");
		expect(rules[2]).to.equal("permit = 203.0.113.0/24");
	});

	it("leaves a deny-only scope open, because a blocklist is not an allowlist", () => {
		// The failure this prevents is an outage: a rule meant to block one abusive /24 turning into
		// "deny everything except that /24".
		const rules = rulesOf(
			render([aclRow({ action: "deny", network: "198.51.100.0/24" })]).body,
			"optimiq-registration",
		);
		expect(rules).to.deep.equal(["deny = 198.51.100.0/24"]);
	});

	it("emits the MORE specific rule last, inverting the table's first-match order", () => {
		// The table says: longest prefix wins. Asterisk says: last line wins. So /32 must come after
		// /24, or the exception is silently discarded.
		const rules = rulesOf(
			render([
				aclRow({ network: "203.0.113.0/24", action: "allow" }),
				aclRow({ network: "203.0.113.9/32", action: "deny" }),
			]).body,
			"optimiq-registration",
		);
		expect(rules).to.deep.equal([
			"deny = 0.0.0.0/0.0.0.0",
			"deny = ::/0",
			"permit = 203.0.113.0/24",
			"deny = 203.0.113.9/32",
		]);
	});

	it("lets a deny win an exact tie with an equally specific allow", () => {
		// `checkAllowlist` states the same tie-break in SQL: "an ACL whose deny can be overridden by
		// an equally-specific allow is an ACL that cannot express an exception".
		const rules = rulesOf(
			render([
				aclRow({ network: "203.0.113.0/24", action: "deny", priority: 100 }),
				aclRow({ network: "203.0.113.0/24", action: "allow", priority: 100 }),
			]).body,
			"optimiq-registration",
		);
		expect(rules[rules.length - 1]).to.equal("deny = 203.0.113.0/24");
	});

	it("emits the LOWER priority last, because lower wins in the table", () => {
		const rules = rulesOf(
			render([
				aclRow({ network: "203.0.113.0/24", action: "allow", priority: 10 }),
				aclRow({ network: "198.51.100.0/24", action: "allow", priority: 900 }),
			]).body,
			"optimiq-registration",
		);
		expect(rules[rules.length - 1]).to.equal("permit = 203.0.113.0/24");
	});

	it("sorts deterministically, so two runs over an unchanged table are byte-identical", () => {
		const rows = [
			aclRow({ network: "203.0.113.0/24" }),
			aclRow({ network: "198.51.100.0/24" }),
			aclRow({ network: "192.0.2.0/24" }),
		];
		const forwards = render(rows).body;
		const backwards = render([...rows].reverse()).body;
		expect(forwards).to.equal(backwards);
	});

	it("skips disabled entries entirely rather than emitting them commented out", () => {
		const result = render([aclRow({ enabled: false, network: "203.0.113.0/24" })]);
		expect(result.body).to.not.contain("203.0.113.0/24");
		expect(rulesOf(result.body, "optimiq-registration")).to.deep.equal([
			"permit = 0.0.0.0/0.0.0.0",
			"permit = ::/0",
		]);
	});

	it("keeps the two SIP scopes in separate sections", () => {
		// The whole reason there is one section per scope: res_pjsip attaches an ACL to an ENDPOINT,
		// and an endpoint knows whether it is a registering phone or a carrier trunk. A socket does
		// not, which is why the union section this file first emitted had nothing to reference it.
		const result = render([
			aclRow({ scope: "registration", network: "203.0.113.0/24" }),
			aclRow({ scope: "trunk", network: "198.51.100.7/32" }),
		]);
		expect(rulesOf(result.body, "optimiq-registration")).to.include("permit = 203.0.113.0/24");
		expect(rulesOf(result.body, "optimiq-registration")).to.not.include("permit = 198.51.100.7/32");
		expect(rulesOf(result.body, "optimiq-trunk")).to.include("permit = 198.51.100.7/32");
		expect(rulesOf(result.body, "optimiq-trunk")).to.not.include("permit = 203.0.113.0/24");
	});

	it("never emits the provisioning or api scopes, which Asterisk cannot enforce", () => {
		// The provisioning allowlist is checked in apps/api against the same rows, and the `api` scope
		// guards an HTTP surface the media server never sees. A section for either would be rules in a
		// file that cannot apply them.
		const result = render([
			aclRow({ scope: "provisioning", network: "203.0.113.0/24" }),
			aclRow({ scope: "api", network: "198.51.100.0/24" }),
		]);
		expect(result.body).to.not.contain("203.0.113.0/24");
		expect(result.body).to.not.contain("198.51.100.0/24");
		expect(result.sections.every((section) => section.mode === "open")).to.equal(true);
	});

	it("unions across tenants and reports when a deny came from more than one", () => {
		const result = render([
			aclRow({ organizationId: ORG_A, action: "deny", network: "198.51.100.0/24" }),
			aclRow({ organizationId: ORG_B, action: "deny", network: "192.0.2.0/24" }),
		]);
		const sip = result.sections.find((section) => section.name === "optimiq-registration");
		expect(sip?.organizations).to.equal(2);
		expect(result.warnings.some((warning) => warning.includes("global"))).to.equal(true);
	});

	it("warns when an allowlist has no IPv6 entry, and does not invent one", () => {
		const result = render([aclRow({ network: "203.0.113.0/24" })]);
		expect(result.warnings.some((warning) => warning.includes("IPv6"))).to.equal(true);
		// Adding a rule nobody wrote could black out a working dual-stack fleet.
		expect(rulesOf(result.body, "optimiq-registration")).to.not.include("permit = ::/0");
	});

	it("carries an IPv6 allow through without the warning", () => {
		const result = render([
			aclRow({ network: "203.0.113.0/24" }),
			aclRow({ network: "2001:db8::/32" }),
		]);
		expect(rulesOf(result.body, "optimiq-registration")).to.include("permit = 2001:db8::/32");
		expect(result.warnings.some((warning) => warning.includes("IPv6"))).to.equal(false);
	});

	it("labels each rule with the entry name and the owning organization", () => {
		// An operator reading acl.conf on a box has to be able to find the row that produced a line.
		const result = render([aclRow({ name: "HQ office", network: "203.0.113.0/24" })]);
		expect(result.body).to.contain("; HQ office — scope registration, priority 100");
		expect(result.body).to.contain(ORG_A);
	});
});

describe("byReversePrecedence", () => {
	it("is the exact mirror of the table's ORDER BY", () => {
		const specific = aclRow({ network: "203.0.113.9/32" });
		const broad = aclRow({ network: "203.0.113.0/24" });
		expect(byReversePrecedence(broad, specific)).to.be.lessThan(0);

		const allow = aclRow({ action: "allow" });
		const deny = aclRow({ action: "deny" });
		expect(byReversePrecedence(allow, deny)).to.be.lessThan(0);

		const urgent = aclRow({ priority: 1 });
		const lax = aclRow({ priority: 900 });
		expect(byReversePrecedence(lax, urgent)).to.be.lessThan(0);
	});
});
