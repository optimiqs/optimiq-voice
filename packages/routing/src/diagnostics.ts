/**
 * Structured diagnostics — the only way this package reports "something about your configuration
 * is wrong" or "this call went nowhere".
 *
 * A compiler that throws on the first bad row is useless to an admin UI: a tenant who mis-typed
 * three IVR destinations wants three field errors, not three round trips. So every check appends a
 * diagnostic and the compiler decides at the end whether the set contains an `error`.
 *
 * The same shape is reused by the resolvers, where diagnostics explain a routing decision after
 * the fact ("blocked by rule X", "toll class denied"). That is deliberate: the support answer to
 * "why did this call hang up?" and the admin answer to "why won't this save?" are the same kind of
 * fact, and one vocabulary means one place to add a new one.
 */

/**
 * `error` fails a compile. `warning` compiles but is worth surfacing in the UI. `info` records a
 * decision the resolver made, for call-path observability.
 */
export const DIAGNOSTIC_SEVERITIES = ["error", "warning", "info"] as const;

export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

/**
 * Every diagnostic this package can raise. A closed tuple rather than free-form strings so the
 * admin UI can map a code to a translated message and a deep link, and so a new check cannot be
 * added without deciding what it is called.
 */
export const DIAGNOSTIC_CODES = [
	// --- structural: the destination graph -----------------------------------------------------
	/** A destination points at an id that is not in the snapshot. */
	"dangling-destination",
	/** A destination's `destinationType` is not a member of the vocabulary. */
	"unknown-destination-type",
	/** The type/ref/data trio is inconsistent (entity without ref, value without data, …). */
	"invalid-destination-shape",
	/** An IVR menu option, timeout or invalid branch points back at its own menu. */
	"self-referencing-ivr",
	/** A cycle exists between IVR menus. Legal at runtime (callers press keys), still worth saying. */
	"ivr-cycle",
	/** A ring group has no enabled destinations, so every call to it dead-ends. */
	"empty-ring-group",
	/** A paging group has no reachable members, so an announcement to it is heard by nobody. */
	"empty-paging-group",
	/** A shared line has no reachable appearances, so a call to it rings nobody. */
	"empty-shared-line",
	/** An outbound route's trunk list is empty after unknown/disabled trunks are dropped. */
	"empty-trunk-list",
	/** An outbound route names a trunk id that is not in the snapshot. */
	"unknown-trunk",
	/** An outbound route names a trunk that exists but is disabled. */
	"disabled-trunk",
	/** A route, DID or feature code references a time condition that is not in the snapshot. */
	"missing-time-condition",
	/** An extension's forward destination resolves to nothing dialable. */
	"unresolvable-forward",
	/** A follow-me hop resolves to nothing dialable — no route, no trunk, or the number is blocked. */
	"unresolvable-follow-me",
	/** Follow-me is switched on for an extension whose ladder has no usable hops. */
	"empty-follow-me",
	/** An extension has voicemail enabled but no mailbox exists for it. */
	"missing-voicemail-box",
	/** An entity names a music-on-hold class that is not in the snapshot, or is disabled. */
	"dangling-moh-class",
	/** A voicemail greeting row belongs to a mailbox that is not in the snapshot. */
	"dangling-voicemail-greeting",
	/** A mailbox's `pinHash` is not in the format `voicemail-pin.ts` defines, so it is not enforced. */
	"invalid-pin-hash",

	// --- the T2 admin block ----------------------------------------------------------------------
	/** A destination alias points at another alias, and the chain loops or is too deep to expand. */
	"alias-cycle",
	/** An audio stream's URL is not an `http(s)` URL a media server may be asked to open. */
	"invalid-stream-url",
	/** A phrase has no playable steps, or one of its steps names another phrase. */
	"invalid-phrase",
	/** A phrase step points at a prompt that is not in the snapshot. */
	"dangling-phrase-step",
	/** A translation rule's regex does not compile, or its replacement could emit non-dialable text. */
	"invalid-translation-rule",
	/** A route or trunk names a translation ruleset that is not in the snapshot, or is disabled. */
	"dangling-translation-ruleset",
	/** An outbound route names a PIN set that is not in the snapshot, is disabled, or has no code. */
	"unusable-pin-set",
	/** A speed-dial code is not dialable, or collides with a feature code or an internal number. */
	"conflicting-speed-dial",
	/** A directory would offer nobody: no extension has a recorded name to speak. */
	"empty-directory",
	/** Two people in a directory spell to the same digits, so a caller cannot tell them apart. */
	"directory-name-collision",
	/** An extension is absent from a directory because its mailbox has no recorded name. */
	"directory-entry-skipped",

	// --- the contact-centre block ---------------------------------------------------------------
	/**
	 * A `queue` destination carried a caller priority that is not a whole number in range.
	 *
	 * A warning and not an error, because the consequence is a caller who waits their turn — the
	 * queue working normally — whereas refusing the compile would take every unrelated route in the
	 * tenant down with it over one mistyped form field.
	 */
	"invalid-queue-priority",
	/** A queue has an exit key and no exit destination, so pressing it hangs the caller up. */
	"queue-exit-key-without-destination",

	// --- organization quotas ----------------------------------------------------------------------
	/**
	 * An organization limit is not a number the engine can enforce, so it was not applied.
	 *
	 * A warning and not an error, for the reason `invalid-queue-priority` is: the artifact is still
	 * routable without the ceiling, and refusing the compile would take every call in the tenant down
	 * to report a quota nobody is currently hitting.
	 */
	"invalid-org-limit",

	// --- emergency dialing (Kari's Law / RAY BAUM'S Act) ----------------------------------------
	/** A DID carries no `emergencyAddressId`, so it cannot serve as an ELIN for the organization. */
	"missing-emergency-address",
	/** A DID names an emergency address that is not in the snapshot, or is not validated. */
	"dangling-emergency-address",
	/** The organization has extensions but no trunk an emergency call could take. */
	"no-emergency-route",
	/** An emergency dial string is also an internal number; the emergency table wins. */
	"emergency-number-shadowed",
	/** A configured emergency number is not a dial string this package can match. */
	"invalid-emergency-number",

	// --- matching tables ------------------------------------------------------------------------
	/** Two entities claim the same internal number (extension 200 and ring group 200). */
	"duplicate-internal-number",
	/** Two feature codes claim the same code, or one code is a prefix of another. */
	"conflicting-feature-code",
	/** Two inbound routes match exactly the same DID input; the lower-priority one never runs. */
	"overlapping-did-pattern",
	/** A route can never be selected — shadowed by an earlier `any`-match route. */
	"unreachable-route",
	/** A route or rule is disabled, or its owning entity is, so it was dropped from the artifact. */
	"disabled-entity",

	// --- patterns and predicates -----------------------------------------------------------------
	/** A regex pattern does not compile. */
	"invalid-regex",
	/** A regex is neither `^`-anchored nor `$`-anchored. On outbound routes that is a fraud risk. */
	"unanchored-regex",
	/** A pattern is empty or exceeds the length bound. */
	"invalid-pattern",
	/** Digit manipulation is nonsensical (negative strip, non-dialable prepend). */
	"invalid-digit-manipulation",
	/** A time rule predicate is out of range or malformed. */
	"invalid-time-rule",
	/** A time condition's timezone is not an IANA zone this runtime knows. */
	"unknown-timezone",
	/** A time condition has no enabled rules, so it can only ever take its no-match branch. */
	"empty-time-condition",

	// --- resolver-only ---------------------------------------------------------------------------
	/** No rule in the context matched the input. */
	"no-match",
	/** A call-block rule matched. */
	"call-blocked",
	/** The originating number is not an extension of this organization. */
	"caller-not-internal",
	/** The caller's toll class does not cover any matching outbound route. */
	"toll-class-denied",
	/** Digit manipulation would consume the whole dialed string. */
	"digit-manipulation-underflow",
	/** Following time-condition / gate nodes exceeded the traversal bound. */
	"plan-depth-exceeded",
	/** A rule matched and its time condition gate was open. */
	"time-condition-open",
	/** A rule matched but its time condition gate was closed. */
	"time-condition-closed",
	/** The dialed string matched the emergency table; every configurable gate was bypassed. */
	"emergency-call",
	/** A translation ruleset rewrote a number, or would have and was refused for over-running. */
	"number-translated",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

const DIAGNOSTIC_CODE_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_CODES);

export function isDiagnosticCode(value: string): value is DiagnosticCode {
	return DIAGNOSTIC_CODE_SET.has(value);
}

/** Which snapshot collection a diagnostic is about, so the UI can focus the right form. */
export interface DiagnosticSubject {
	/** Singular entity name, e.g. `inbound-route`, `ivr-menu-option`. */
	readonly kind: string;
	readonly id: string;
	/** Human label, when the row has one. Purely for the message. */
	readonly name?: string;
}

export interface Diagnostic {
	readonly severity: DiagnosticSeverity;
	readonly code: DiagnosticCode;
	readonly message: string;
	readonly subject?: DiagnosticSubject;
	/** Dotted path into the snapshot, e.g. `inboundRoutes[3].destinationRef`. */
	readonly path?: string;
}

/**
 * Accumulates diagnostics in insertion order.
 *
 * Insertion order is the compile order, and the compile order is deterministic (every collection
 * is sorted before it is walked), so the diagnostic list of a given snapshot is itself
 * deterministic and safe to hash or snapshot-test.
 */
export class DiagnosticBag {
	private readonly entries: Diagnostic[] = [];

	add(diagnostic: Diagnostic): this {
		this.entries.push(diagnostic);
		return this;
	}

	error(code: DiagnosticCode, message: string, subject?: DiagnosticSubject, path?: string): this {
		return this.add(withOptional({ severity: "error", code, message }, subject, path));
	}

	warning(code: DiagnosticCode, message: string, subject?: DiagnosticSubject, path?: string): this {
		return this.add(withOptional({ severity: "warning", code, message }, subject, path));
	}

	info(code: DiagnosticCode, message: string, subject?: DiagnosticSubject, path?: string): this {
		return this.add(withOptional({ severity: "info", code, message }, subject, path));
	}

	get size(): number {
		return this.entries.length;
	}

	hasErrors(): boolean {
		return this.entries.some((entry) => entry.severity === "error");
	}

	/** Everything, in insertion order. */
	all(): readonly Diagnostic[] {
		return [...this.entries];
	}

	bySeverity(severity: DiagnosticSeverity): readonly Diagnostic[] {
		return this.entries.filter((entry) => entry.severity === severity);
	}
}

function withOptional(
	base: { severity: DiagnosticSeverity; code: DiagnosticCode; message: string },
	subject?: DiagnosticSubject,
	path?: string,
): Diagnostic {
	if (subject === undefined && path === undefined) {
		return base;
	}
	if (path === undefined) {
		return { ...base, subject };
	}
	if (subject === undefined) {
		return { ...base, path };
	}
	return { ...base, subject, path };
}

/** Renders diagnostics for a log line or an error message. One per line, most severe first. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
	const order: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };
	return [...diagnostics]
		.sort((left, right) => order[left.severity] - order[right.severity])
		.map((entry) => {
			const subject =
				entry.subject === undefined ? "" : ` [${entry.subject.kind}:${entry.subject.id}]`;
			const path = entry.path === undefined ? "" : ` (${entry.path})`;
			return `${entry.severity}: ${entry.code}${subject}${path} — ${entry.message}`;
		})
		.join("\n");
}
