import type { SipAclAction, SipAclScope } from "@optimiq-voice/pbx-db";

/**
 * Renders `acl.conf` from the `sip_acl_entry` table.
 *
 * ## The gap this closes
 *
 * `apps/asterisk/config/acl.conf` was the literal line `; Placeholder`, and `sip_acl_entry` had one
 * reader anywhere in the platform — the provisioning render endpoint's own allowlist check. The
 * parity audit ranks the consequence fourth ("A single compromised extension is unbounded financial
 * exposure") and calls it the FreeSWITCH inventory's toll-fraud rule #1. This is the SIP-edge half:
 * the table becomes a CIDR gate in front of the media server's transports.
 *
 * ## Pure, on the same terms as `musiconhold-conf.ts`
 *
 * A function from rows to a string, with no database and no filesystem;
 * `scripts/generate-sip-acl.ts` does the reading and the writing. Same reason recorded there and in
 * `src/provisioning/catalog/`: a TypeScript function per output is the same amount of code as a
 * string template with the compiler switched on, and it keeps a golden assertion meaningful.
 *
 * ## Asterisk evaluates LAST match wins. The table says FIRST match wins.
 *
 * This is the one genuinely subtle thing in the file, so it is stated before anything else.
 *
 * `security-schema.ts` documents the table's precedence as *"lower first; ties are broken by the
 * most specific prefix"* — a first-match-wins order, which is what `checkAllowlist` implements in
 * SQL (`order by masklen desc, deny first, priority asc … limit 1`).
 *
 * Asterisk's ACLs are the other convention: `permit=` / `deny=` lines are applied in sequence and
 * the LAST rule that matches an address determines the verdict. That is why the canonical Asterisk
 * idiom is `deny=0.0.0.0/0` followed by the permits.
 *
 * Two orders, one table. The renderer therefore emits rows in REVERSE precedence order — weakest
 * first, strongest last — so that Asterisk's last-match-wins arrives at the same verdict the
 * database's first-match-wins does. Getting this backwards produces a file that parses perfectly
 * and inverts every exception, which is why it is a sort with a name
 * ({@link byReversePrecedence}) and a test rather than a comparator inline.
 *
 * ## The implicit deny, and when it is implicit
 *
 * A scope with at least one `allow` row is an ALLOWLIST, and an allowlist that does not deny
 * everything else is not one. So a leading `deny = 0.0.0.0/0.0.0.0` (and its IPv6 twin) is emitted
 * for any scope that has an allow row.
 *
 * A scope with only `deny` rows is a BLOCKLIST — "everyone except these" — and gets no leading
 * deny, because adding one would turn "block this abusive /24" into "block the internet", which is
 * an outage produced by a rule that was meant to be a narrowing.
 *
 * A scope with no rows at all is permit-all, spelled explicitly rather than left as an empty
 * section. An empty named ACL in Asterisk is permit-all too, but a dangling REFERENCE is also
 * permit-all with a warning nobody reads, and writing the permits out means the difference between
 * the two is visible in the file.
 *
 * ## One file, no tenant dimension — the same shape as the hold-music collision
 *
 * `acl.conf` is global: a named ACL is a name and a list of prefixes, with no tenant column
 * anywhere. So the rows of every tenant are UNIONED into one named ACL per scope.
 *
 * The consequence is real and is not papered over: **one tenant's allowlist does not exclude
 * another tenant's addresses**, and a deny written by one tenant applies to every tenant on the
 * box. That asymmetry is reported in {@link AclRender.warnings} rather than resolved, because
 * resolving it means one named ACL per tenant, which means one endpoint per tenant — the dynamic
 * endpoint generation this platform does not have on the Asterisk plane, and which `apps/sipd` is
 * where per-AOR policy actually lands.
 *
 * What this file buys today is the platform-wide perimeter: the thing that stops a scanner in
 * another hemisphere from ever reaching the authenticator, and the trunk rule that stops an INVITE
 * from anywhere but the carrier's own signalling network. That is the control the FreeSWITCH
 * inventory's "toll fraud rule #1" is actually about.
 *
 * ## Where a section is referenced from
 *
 * `optimiq-registration` from every registering endpoint's `acl` AND `contact_acl` — the second
 * being the toll-fraud one, since a device that authenticates legitimately and then registers a
 * Contact pointing at a third-party host has turned this platform into a relay.
 * `optimiq-trunk` from the carrier wizard's `endpoint/acl`.
 */

/** One row of `sip_acl_entry`. Only what the file needs. */
export interface SipAclRow {
	readonly id: string;
	readonly organizationId: string;
	readonly name: string | null;
	/** Normalised by Postgres's `cidr` type, e.g. `203.0.113.0/24`. */
	readonly network: string;
	readonly action: SipAclAction;
	readonly scope: SipAclScope;
	readonly priority: number;
	readonly enabled: boolean;
}

export interface AclRenderOptions {
	/** Stamped into the banner. Injected so a golden assertion is not a clock race. */
	readonly generatedAt?: string;
	/** Stamped into the banner so a file on a box can be traced to the run that made it. */
	readonly source?: string;
}

export interface AclSectionSummary {
	readonly name: string;
	/** `allowlist` once any allow row exists, `blocklist` with only denies, `open` with neither. */
	readonly mode: "allowlist" | "blocklist" | "open";
	readonly rules: number;
	/** How many organizations contributed a rule to this section. */
	readonly organizations: number;
}

export interface AclRender {
	readonly body: string;
	readonly sections: readonly AclSectionSummary[];
	/** Things an operator should know happened. Never fatal; the file is always renderable. */
	readonly warnings: readonly string[];
}

/**
 * The named ACLs this file declares, and which scope feeds each.
 *
 * ONE SECTION PER SCOPE, because res_pjsip attaches an ACL to an ENDPOINT and an endpoint knows
 * which scope it is. A union section was written first, on the assumption that the gate would hang
 * off the transport; bringing it up disproved that — the PJSIP `transport` object has no `acl`
 * option, and res_pjsip does not ignore the unknown key, it refuses to create the transport. So
 * there is no socket-level attachment point to union for, and a union section would be a section
 * nothing references.
 *
 * The per-endpoint seam is the better one anyway. A socket cannot tell a registration from a trunk
 * INVITE, so a transport gate would have had to permit the union of both scopes and could never
 * have been narrower than the loosest rule on the box.
 *
 * `provisioning` and `api` get no section, by design. Neither is enforced by Asterisk: the
 * provisioning allowlist is checked in `apps/api` against these same rows
 * (`provision.repository.ts`), and the `api` scope guards an HTTP surface Asterisk never sees.
 * Emitting rules into a file that cannot apply them is the failure this whole wave is about.
 */
const SECTIONS: readonly { readonly name: string; readonly scopes: readonly SipAclScope[] }[] = [
	{ name: "optimiq-registration", scopes: ["registration"] },
	{ name: "optimiq-trunk", scopes: ["trunk"] },
];

/** `203.0.113.0/24` -> 24. Missing or unparseable suffixes sort as the least specific. */
function prefixLength(network: string): number {
	const slash = network.lastIndexOf("/");
	if (slash === -1) {
		return 0;
	}
	const parsed = Number(network.slice(slash + 1));
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Weakest first, strongest last — the inverse of the table's precedence, so Asterisk's
 * last-match-wins agrees with the database's first-match-wins.
 *
 * Read the comparisons as the mirror of `checkAllowlist`'s `ORDER BY`:
 *
 * | table (first wins)        | here (last wins)          |
 * |---------------------------|---------------------------|
 * | `masklen desc`            | prefix ASCENDING          |
 * | deny before allow         | allow before DENY         |
 * | `priority asc`            | priority DESCENDING       |
 *
 * `id` last, so two rows that are equal on every ranked field still sort deterministically and two
 * runs over an unchanged database produce a byte-identical file.
 */
export function byReversePrecedence(left: SipAclRow, right: SipAclRow): number {
	const prefix = prefixLength(left.network) - prefixLength(right.network);
	if (prefix !== 0) {
		return prefix;
	}
	if (left.action !== right.action) {
		// `allow` first so a `deny` at the same specificity is applied after it and therefore wins,
		// which is the tie-break `checkAllowlist` states: "an ACL whose deny can be overridden by an
		// equally-specific allow is an ACL that cannot express an exception".
		return left.action === "allow" ? -1 : 1;
	}
	if (left.priority !== right.priority) {
		return right.priority - left.priority;
	}
	return left.id.localeCompare(right.id);
}

/** Whether a network is IPv6. Only `:` can appear in one and never in a dotted quad. */
function isIpv6(network: string): boolean {
	return network.includes(":");
}

function renderSection(
	name: string,
	scopes: readonly SipAclScope[],
	rows: readonly SipAclRow[],
	warnings: string[],
): { readonly lines: readonly string[]; readonly summary: AclSectionSummary } {
	const scoped = rows
		.filter((row) => row.enabled && scopes.includes(row.scope))
		.sort(byReversePrecedence);

	const hasAllow = scoped.some((row) => row.action === "allow");
	const hasDeny = scoped.some((row) => row.action === "deny");
	const mode = hasAllow ? "allowlist" : hasDeny ? "blocklist" : "open";

	const lines: string[] = [`[${name}]`];

	if (mode === "open") {
		lines.push(
			"; No enabled entries in this scope. Permit-all, spelled out rather than left as an empty",
			"; section, so an unconfigured ACL and a broken reference do not look the same in the file.",
			"permit = 0.0.0.0/0.0.0.0",
			"permit = ::/0",
		);
	} else if (mode === "allowlist") {
		lines.push(
			"; An allow entry exists, so this scope is an ALLOWLIST and everything else is denied.",
			"; Asterisk applies rules in order and the LAST match wins, so the deny goes first.",
			"deny = 0.0.0.0/0.0.0.0",
			"deny = ::/0",
		);
	} else {
		lines.push(
			"; Deny entries only, so this scope is a BLOCKLIST: everything not listed is permitted.",
			"; No leading deny — adding one would turn 'block this /24' into 'block the internet'.",
		);
	}

	for (const row of scoped) {
		const keyword = row.action === "allow" ? "permit" : "deny";
		const label = row.name ?? row.network;
		lines.push(
			`; ${label} — scope ${row.scope}, priority ${row.priority}, org ${row.organizationId}`,
			`${keyword} = ${row.network}`,
		);
	}

	// A scope that denies but never permits over IPv6 while the transport is dual-stack is a gate
	// with a door left open, and it is invisible in the file because the missing rule is the whole
	// problem. Named rather than silently corrected: adding a `deny = ::/0` nobody wrote could black
	// out a working IPv6 fleet.
	if (mode === "allowlist" && !scoped.some((row) => isIpv6(row.network))) {
		warnings.push(
			`[${name}] is an allowlist with no IPv6 entry — every IPv6 source is denied. That is ` +
				"correct for an IPv4-only deployment and an outage for a dual-stack one.",
		);
	}

	const organizations = new Set(scoped.map((row) => row.organizationId));
	if (mode === "blocklist" && organizations.size > 1) {
		warnings.push(
			`[${name}] carries deny entries from ${organizations.size} organizations. acl.conf is ` +
				"global — a deny written by one tenant applies to every tenant on this media server.",
		);
	}

	return {
		lines,
		summary: { name, mode, rules: scoped.length, organizations: organizations.size },
	};
}

export function renderAclConf(
	rows: readonly SipAclRow[],
	options: AclRenderOptions = {},
): AclRender {
	const warnings: string[] = [];
	const sections: AclSectionSummary[] = [];
	const body: string[] = [
		"; ==============================================================================",
		"; GENERATED FILE — DO NOT EDIT",
		"; ==============================================================================",
		";",
		"; Rendered from the `sip_acl_entry` table by",
		";",
		";     pnpm --filter @optimiq-voice/api generate:sip-acl",
		";",
		"; Edit the entries in the admin UI (`/api/v1/sip-acl-entries`) and regenerate. Anything",
		"; written here by hand is lost on the next run.",
		";",
		"; Asterisk applies ACL rules IN ORDER and the LAST match wins, which is the inverse of the",
		"; table's own precedence. The rows below are therefore emitted weakest-first so that both",
		"; conventions reach the same verdict — see `apps/api/src/pbx/security/acl-conf.ts`.",
		";",
		"; The media server picks this up on restart. Without one:",
		";",
		";     asterisk -rx 'module reload res_pjsip.so'",
		";",
		"; — a bare `acl reload` refreshes the named ACLs but a PJSIP endpoint caches the one it",
		"; resolved at load, so the endpoints are what have to be rebuilt for a change to bite.",
	];
	if (options.source !== undefined) {
		body.push(`;`, `; Source: ${options.source}`);
	}
	if (options.generatedAt !== undefined) {
		body.push(`; Generated: ${options.generatedAt}`);
	}
	body.push("");

	for (const section of SECTIONS) {
		const rendered = renderSection(section.name, section.scopes, rows, warnings);
		body.push(...rendered.lines, "");
		sections.push(rendered.summary);
	}

	return { body: `${body.join("\n").trimEnd()}\n`, sections, warnings };
}
