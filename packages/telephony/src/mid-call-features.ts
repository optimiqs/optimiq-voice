/**
 * Mid-call feature codes — the digits somebody presses while they are already talking to somebody.
 *
 * Frozen source of truth: `plans/reference/freeswitch-capabilities.md` §4 (per-channel DTMF queue,
 * inter-digit timeouts) and §3 (blind transfer, park, on-demand recording as the three operations a
 * party can start from the keypad without hanging up).
 *
 * ## Why this is not the routing compiler's feature-code table
 *
 * `packages/routing` compiles a **dial-time** catalogue: the caller has no call yet, they dial
 * `*97`, the digits are a destination and the whole string is matched at once. Everything here
 * happens to a call that is ALREADY UP, where the digits arrive one at a time from a bridged party,
 * where most of them are meant for the far end rather than for us, and where the decision to stop
 * passing them through has to be made on the FIRST digit — before we know what the code is going to
 * be.
 *
 * That is why this is a state machine and not a string match. The interesting question is never
 * "what does `*1` mean"; it is "this party pressed `*`, do I swallow the next four digits or send
 * them to the person they are talking to?".
 *
 * ## Why the vocabulary is duplicated rather than imported
 *
 * `packages/routing` depends on this package, so this package cannot depend on it. The duplication
 * is four action names ({@link MID_CALL_FEATURE_ACTIONS}), and it buys the engine the freedom to
 * source the table from the compiled artifact WITHOUT dragging the compiler into the pure domain.
 * The engine maps one onto the other in a single function; see the note on
 * {@link MidCallFeatureCode.action}.
 *
 * ## What is deliberately NOT here
 *
 * **SIP REFER.** A phone with a hardware transfer key sends `REFER`, not DTMF, and that arrives at
 * the SIP edge (`apps/sipd`) rather than at the media server. Nothing in this file helps with it,
 * and pretending otherwise would leave a gap that reads as "transfer is done" on a roadmap. REFER
 * is `sipd`'s, later.
 *
 * **Clocks.** This package has no timers. The machine is told the time on every call and reports
 * when it wants to be woken; the engine owns `setTimeout`. See {@link MidCallFeatureStep.wakeAtMs}.
 *
 * Per the oikos convention (`plans/reference/oikos-conventions.md` §4) the machine is a
 * `VALID_TRANSITIONS` const with terminal states of `[]`, and every mutation is guard-then-execute:
 * `assertMidCallFeatureTransition` before the write, never after.
 */

import { isDtmfDigit } from "./dtmf";
import { InvalidMidCallFeatureTransitionError } from "./errors";
import type { DtmfDigit } from "./dtmf";

// ---------------------------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * The operations a party can start from the keypad mid-call.
 *
 * A CLOSED set, and deliberately much smaller than the dial-time catalogue. A code only belongs
 * here if it is meaningful against a call that is already connected and the engine has a runtime
 * for it:
 *
 * - `blind-transfer` — hand the other party to somebody else. Needs a destination, so it is the one
 *   action that collects digits.
 * - `record-toggle` — start or stop an on-demand recording of this conversation.
 * - `park` — put the other party in an orbit slot. Takes an optional orbit.
 * - `cancel` — abandon an attended-transfer consultation and go back to the original party. Not a
 *   dial-time code at all: it is the `cancelKey` of a `transfer` verb, and it is in this table so
 *   that ONE machine decides what happens to a digit rather than two racing readers of one queue.
 *
 * Everything else in the dial-time catalogue (`*72` call-forward, `*78` DND, `*97` voicemail) is a
 * configuration change or a destination, and a party in the middle of a conversation reaches it by
 * making a second call — which is what they do on every other phone system too.
 */
export const MID_CALL_FEATURE_ACTIONS = [
	"blind-transfer",
	"record-toggle",
	"park",
	"cancel",
] as const;

export type MidCallFeatureAction = (typeof MID_CALL_FEATURE_ACTIONS)[number];

/**
 * How an action consumes the digits dialled after its code.
 *
 * The same three-way distinction the dial-time compiler makes, for the same reason: without it the
 * table is a plain string map and `*1` could never carry a destination.
 */
export const MID_CALL_ARGUMENT_MODES = ["none", "optional", "required"] as const;

export type MidCallArgumentMode = (typeof MID_CALL_ARGUMENT_MODES)[number];

/**
 * Argument mode per action. Exhaustive by construction: adding an action without deciding how it
 * consumes digits is a TypeScript error here rather than a code that silently never fires.
 */
export const MID_CALL_ARGUMENT_MODE: Readonly<Record<MidCallFeatureAction, MidCallArgumentMode>> = {
	// A transfer with no destination is not a transfer.
	"blind-transfer": "required",
	"record-toggle": "none",
	// Bare `*5` auto-assigns an orbit; `*5401` asks for 401.
	park: "optional",
	// A cancel key is one digit and means one thing.
	cancel: "none",
} as const;

/** One row of the table the machine matches against. */
export interface MidCallFeatureCode {
	/** The dialled prefix, e.g. `*1`. Every character must be a DTMF symbol. */
	readonly code: string;
	/**
	 * What it does.
	 *
	 * The engine builds this from the compiled artifact's own catalogue so a tenant that renumbered
	 * `*1` to `*7` gets the renumbered code mid-call too. The mapping is
	 * `transfer → blind-transfer`, `record-toggle → record-toggle`, `call-park → park`; every other
	 * compiled action has no mid-call runtime and is simply not offered here.
	 */
	readonly action: MidCallFeatureAction;
	/** Defaults to {@link MID_CALL_ARGUMENT_MODE}; overridden only by a spec. */
	readonly argumentMode?: MidCallArgumentMode;
}

// ---------------------------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------------------------

/**
 * Every stage a mid-call feature-code capture can occupy, in canonical order.
 *
 * - `idle` — nothing is being captured. Digits pass through to the far end. This is where a call
 *   spends essentially all of its life, and it is NOT terminal: the machine is reusable, because a
 *   party who parks a call and then transfers another one is one party pressing keys twice.
 * - `armed` — a lead digit was seen and the machine is accumulating a CODE. Digits are swallowed,
 *   because a `*` that reached the far end after we decided to watch for `*1` would be a `*` the
 *   remote IVR acts on for a transfer that then also happens.
 * - `collecting` — the code matched something that takes an argument, and the machine is
 *   accumulating the ARGUMENT. Ends on the terminator, on the inter-digit timeout, or at
 *   {@link MidCallFeatureSettings.maxArgumentDigits}.
 * - `executing` — the action has been handed to the engine and the engine has not finished it. New
 *   digits are swallowed rather than starting a second capture: a party who presses `*1200` and
 *   then, impatiently, `*1200` again must not queue two transfers.
 *
 * There is no terminal stage. A capture ENDS by returning to `idle` — see {@link MidCallFeatureMachine.settle}.
 */
export const MID_CALL_FEATURE_STATES = ["idle", "armed", "collecting", "executing"] as const;

export type MidCallFeatureState = (typeof MID_CALL_FEATURE_STATES)[number];

/** The stage every capture starts in, and the one it returns to. */
export const INITIAL_MID_CALL_FEATURE_STATE = "idle" satisfies MidCallFeatureState;

/**
 * Adjacency of the machine.
 *
 * Invariants pinned by `mid-call-features.spec.ts`:
 * 1. No stage is terminal — the machine is reused for the life of the call.
 * 2. `executing` is reachable from `armed` (a no-argument code) and from `collecting` (an
 *    argument-taking one), and from nowhere else. An action that fired straight out of `idle`
 *    would mean a single digit ran a transfer.
 * 3. Every stage can reach `idle`, because every stage can be abandoned: a partial code that
 *    matches nothing, an inter-digit timeout, a hangup.
 * 4. `collecting` is reachable ONLY from `armed`. There is no way to collect an argument for a code
 *    that was never matched.
 * 5. No state lists itself. Accumulating a second digit in `armed` is not a transition.
 */
export const VALID_MID_CALL_FEATURE_TRANSITIONS = {
	idle: ["armed"],
	armed: ["collecting", "executing", "idle"],
	collecting: ["executing", "idle"],
	executing: ["idle"],
} as const satisfies Record<MidCallFeatureState, readonly MidCallFeatureState[]>;

const MID_CALL_FEATURE_STATE_SET = new Set<string>(MID_CALL_FEATURE_STATES);

/** Type guard for a stage arriving from an event or a snapshot. */
export function isMidCallFeatureState(value: string): value is MidCallFeatureState {
	return MID_CALL_FEATURE_STATE_SET.has(value);
}

/** The stages reachable in one step. Never `undefined`. */
export function midCallFeatureTransitionsFrom(
	state: MidCallFeatureState,
): readonly MidCallFeatureState[] {
	return VALID_MID_CALL_FEATURE_TRANSITIONS[state];
}

/** Whether the machine connects `from` to `to` in exactly one step. */
export function isValidMidCallFeatureTransition(
	from: MidCallFeatureState,
	to: MidCallFeatureState,
): boolean {
	return (VALID_MID_CALL_FEATURE_TRANSITIONS[from] as readonly MidCallFeatureState[]).includes(to);
}

/**
 * Guard for guard-then-execute: call before mutating the stored stage, never after.
 *
 * @throws {InvalidMidCallFeatureTransitionError} when the edge does not exist.
 */
export function assertMidCallFeatureTransition(
	from: MidCallFeatureState,
	to: MidCallFeatureState,
): void {
	if (!isValidMidCallFeatureTransition(from, to)) {
		throw new InvalidMidCallFeatureTransitionError(from, to);
	}
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

/** Timing and shape knobs. All have defaults; none is a product decision. */
export interface MidCallFeatureSettings {
	/**
	 * How long the machine waits for the next digit of a CODE before giving up on it.
	 *
	 * Short, because the cost of being wrong is asymmetric: a party who pressed `*` for the far
	 * end's IVR and then paused gets their `*` back late, which is a nuisance, whereas a machine
	 * that waited three seconds for every stray `*` would swallow half of an IVR interaction.
	 */
	readonly codeTimeoutMs: number;
	/**
	 * How long it waits between digits of an ARGUMENT before executing what it has.
	 *
	 * Longer than the code timeout: by this point the party has committed to a feature and is
	 * typing an extension number, which is exactly the situation `play_and_get_digits`' own
	 * inter-digit timeout exists for.
	 */
	readonly interDigitTimeoutMs: number;
	/** Ends an argument immediately. `#` everywhere, as on every phone system since 1963. */
	readonly terminator: DtmfDigit;
	/**
	 * A bound, not a policy. An argument this long is somebody leaning on a key, and collecting
	 * without limit means a capture that never resolves and a far end that never hears a digit again.
	 */
	readonly maxArgumentDigits: number;
}

export const DEFAULT_MID_CALL_FEATURE_SETTINGS: MidCallFeatureSettings = {
	codeTimeoutMs: 1_500,
	interDigitTimeoutMs: 4_000,
	terminator: "#",
	maxArgumentDigits: 16,
};

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

/**
 * What the engine must do with the digit it just offered.
 *
 * - `pass-through` — not ours. Send it to the far end / the verb executor exactly as before. This
 *   is the answer for the overwhelming majority of digits, and it is the DEFAULT for anything the
 *   machine does not positively recognise.
 * - `captured` — swallowed, and nothing has been decided yet. The far end must NOT see it.
 * - `execute` — swallowed, and this action is now the engine's to run. Exactly one of these is
 *   emitted per capture.
 * - `abandoned` — the capture came to nothing (a code that matched no row, a timeout). Carries the
 *   digits that were swallowed on the way, so the engine can log what a user actually pressed when
 *   they complain that "the transfer key does not work".
 */
export type MidCallFeatureStepKind = "pass-through" | "captured" | "execute" | "abandoned";

/** An action the engine has been handed. */
export interface MidCallFeatureExecution {
	readonly action: MidCallFeatureAction;
	/** The code that produced it, as the tenant numbered it. For the log and the event. */
	readonly code: string;
	/** Digits dialled after the code. Empty when the code was dialled alone. */
	readonly argument: string;
}

export interface MidCallFeatureStep {
	readonly kind: MidCallFeatureStepKind;
	readonly state: MidCallFeatureState;
	/** Set when `kind` is `execute`. */
	readonly execution?: MidCallFeatureExecution;
	/** Set when `kind` is `abandoned`: everything that was swallowed, in order. */
	readonly swallowed?: string;
	/**
	 * When the machine wants {@link MidCallFeatureMachine.expire} called, as an absolute instant.
	 *
	 * Absent means "no timer" — the engine cancels whatever it had armed. Present on EVERY step that
	 * leaves the machine mid-capture, including the ones that merely re-armed it, so an engine that
	 * unconditionally re-arms on each step is correct without knowing the rules.
	 */
	readonly wakeAtMs?: number;
}

// ---------------------------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------------------------

/** The argument mode of a row: its override, else the action's own. */
export function argumentModeOf(entry: MidCallFeatureCode): MidCallArgumentMode {
	return entry.argumentMode ?? MID_CALL_ARGUMENT_MODE[entry.action];
}

/**
 * Puts a table into the order the machine walks it, and drops what it cannot use.
 *
 * Longest code first, so `*80` wins over `*8` — the same rule the dial-time matcher follows, and
 * for the same reason. Rows whose code is empty or contains a non-DTMF character are DROPPED rather
 * than tolerated: a code nobody can press is a row that only makes the table longer.
 *
 * Ties are broken by code then action so the ordering is total and a spec can assert it.
 */
export function orderMidCallFeatureCodes(
	table: readonly MidCallFeatureCode[],
): readonly MidCallFeatureCode[] {
	return [...table]
		.filter((entry) => entry.code.length > 0 && [...entry.code].every((c) => isDtmfDigit(c)))
		.sort(
			(left, right) =>
				right.code.length - left.code.length ||
				left.code.localeCompare(right.code) ||
				left.action.localeCompare(right.action),
		);
}

// ---------------------------------------------------------------------------------------------
// The machine itself
// ---------------------------------------------------------------------------------------------

/**
 * One party's mid-call capture, as a reusable machine.
 *
 * Pure: no clock, no timers, no I/O. `push` and `expire` take the current instant and the machine
 * reports the instant it next wants to be woken at. The engine owns the `setTimeout` because the
 * engine is the only thing that can cancel one when the leg hangs up.
 *
 * ## The two-phase match, and why a partial code is not abandoned immediately
 *
 * A table containing `*1` and `*12` means the machine cannot fire on `*1` the moment it sees it —
 * `*12` is still live. So `armed` distinguishes three answers about the accumulated string:
 *
 * 1. **A row matches exactly and no longer row could still extend it** → fire (or start collecting).
 * 2. **No row matches but some row still starts with it** → keep swallowing.
 * 3. **Neither** → abandon, and hand the swallowed digits back to the engine.
 *
 * Case 1's second clause is what makes `*1` and `*12` coexist. Without it, `*12` is unreachable.
 * With it, `*1` fires on the code timeout rather than instantly, which is the honest trade and the
 * reason {@link MidCallFeatureSettings.codeTimeoutMs} is short.
 */
export class MidCallFeatureMachine {
	private readonly table: readonly MidCallFeatureCode[];
	private readonly settings: MidCallFeatureSettings;
	private readonly leadDigits: ReadonlySet<string>;

	private current: MidCallFeatureState = INITIAL_MID_CALL_FEATURE_STATE;
	private code = "";
	private argument = "";
	private matched: MidCallFeatureCode | undefined;
	private deadlineMs: number | undefined;

	constructor(
		table: readonly MidCallFeatureCode[],
		settings: Partial<MidCallFeatureSettings> = {},
	) {
		this.table = orderMidCallFeatureCodes(table);
		this.settings = { ...DEFAULT_MID_CALL_FEATURE_SETTINGS, ...settings };
		this.leadDigits = new Set(this.table.map((entry) => entry.code[0] as string));
	}

	get state(): MidCallFeatureState {
		return this.current;
	}

	/** Whether anything is being captured. The engine's cheap "should I even ask?" check. */
	get isCapturing(): boolean {
		return this.current !== INITIAL_MID_CALL_FEATURE_STATE;
	}

	/** The rows this machine will match, in match order. Read by a spec and by `/healthz`. */
	get codes(): readonly MidCallFeatureCode[] {
		return this.table;
	}

	/** Offers one digit. See {@link MidCallFeatureStep}. */
	push(digit: string, nowMs: number): MidCallFeatureStep {
		const symbol = digit.toUpperCase();
		if (!isDtmfDigit(symbol)) {
			// Not a DTMF symbol at all. It is not ours and it is not the machine's job to police it.
			return this.step("pass-through");
		}

		switch (this.current) {
			case "idle":
				return this.pushIdle(symbol, nowMs);
			case "armed":
				return this.pushArmed(symbol, nowMs);
			case "collecting":
				return this.pushCollecting(symbol, nowMs);
			case "executing":
				// The engine is mid-transfer. Swallow: a digit that reached the far end now would arrive
				// at whoever the call is being handed to, which is not who pressed it.
				return this.step("captured");
		}
	}

	/**
	 * The armed timer fired.
	 *
	 * `nowMs` is compared against the deadline rather than trusted, so a timer that fired late — or
	 * a spec that calls this early — cannot end a capture the party is still typing into.
	 */
	expire(nowMs: number): MidCallFeatureStep {
		if (this.deadlineMs === undefined || nowMs < this.deadlineMs) {
			return this.step(this.current === "idle" ? "pass-through" : "captured");
		}

		if (this.current === "armed") {
			// A code that is a complete row fires on the timeout: this is the `*1` / `*12` tie-break.
			const exact = this.table.find((entry) => entry.code === this.code);
			if (exact !== undefined && argumentModeOf(exact) !== "required") {
				return this.beginExecuting(exact, "", nowMs);
			}
			return this.abandon();
		}
		if (this.current === "collecting") {
			const entry = this.matched;
			if (entry === undefined) {
				return this.abandon();
			}
			if (this.argument.length === 0 && argumentModeOf(entry) === "required") {
				// `*1` with no destination. Executing it would be a transfer to nowhere.
				return this.abandon();
			}
			return this.beginExecuting(entry, this.argument, nowMs);
		}
		return this.step(this.current === "idle" ? "pass-through" : "captured");
	}

	/**
	 * The engine has finished running the action. Back to `idle`.
	 *
	 * Separate from `push` because the operations this machine starts are asynchronous and slow — a
	 * blind transfer walks a routing plan and rings a phone. A machine that reset itself the instant
	 * it emitted `execute` would start a second capture from the digits the party presses while they
	 * wait for the first one.
	 */
	settle(): MidCallFeatureStep {
		if (this.current !== "executing") {
			return this.step(this.current === "idle" ? "pass-through" : "captured");
		}
		assertMidCallFeatureTransition("executing", "idle");
		return this.reset();
	}

	/** Abandons any capture without running anything: a hangup, a drain, a new verb taking the leg. */
	cancel(): MidCallFeatureStep {
		if (this.current === "idle") {
			return this.step("pass-through");
		}
		return this.abandon();
	}

	// -----------------------------------------------------------------------------------------

	private pushIdle(symbol: DtmfDigit, nowMs: number): MidCallFeatureStep {
		if (!this.leadDigits.has(symbol)) {
			return this.step("pass-through");
		}
		assertMidCallFeatureTransition("idle", "armed");
		this.current = "armed";
		this.code = symbol;
		this.argument = "";
		this.matched = undefined;
		return this.resolveCode(nowMs);
	}

	private pushArmed(symbol: DtmfDigit, nowMs: number): MidCallFeatureStep {
		this.code += symbol;
		return this.resolveCode(nowMs);
	}

	/** The three answers described on the class doc, in that order. */
	private resolveCode(nowMs: number): MidCallFeatureStep {
		const extendable = this.table.some(
			(entry) => entry.code.length > this.code.length && entry.code.startsWith(this.code),
		);
		const exact = this.table.find((entry) => entry.code === this.code);

		if (exact !== undefined && !extendable) {
			const mode = argumentModeOf(exact);
			if (mode === "none") {
				return this.beginExecuting(exact, "", nowMs);
			}
			assertMidCallFeatureTransition("armed", "collecting");
			this.current = "collecting";
			this.matched = exact;
			this.argument = "";
			return this.arm("captured", nowMs + this.settings.interDigitTimeoutMs);
		}

		if (exact !== undefined || extendable) {
			// Either a complete code that a longer one could still extend, or an honest prefix. Both
			// keep swallowing, and both are resolved by the code timeout.
			return this.arm("captured", nowMs + this.settings.codeTimeoutMs);
		}

		return this.abandon();
	}

	private pushCollecting(symbol: DtmfDigit, nowMs: number): MidCallFeatureStep {
		const entry = this.matched;
		if (entry === undefined) {
			return this.abandon();
		}
		if (symbol === this.settings.terminator) {
			if (this.argument.length === 0 && argumentModeOf(entry) === "required") {
				return this.abandon();
			}
			return this.beginExecuting(entry, this.argument, nowMs);
		}

		this.argument += symbol;
		if (this.argument.length >= this.settings.maxArgumentDigits) {
			return this.beginExecuting(entry, this.argument, nowMs);
		}
		return this.arm("captured", nowMs + this.settings.interDigitTimeoutMs);
	}

	private beginExecuting(
		entry: MidCallFeatureCode,
		argument: string,
		_nowMs: number,
	): MidCallFeatureStep {
		assertMidCallFeatureTransition(this.current as "armed" | "collecting", "executing");
		this.current = "executing";
		this.deadlineMs = undefined;
		const execution: MidCallFeatureExecution = {
			action: entry.action,
			code: entry.code,
			argument,
		};
		this.matched = undefined;
		this.code = "";
		this.argument = "";
		return { kind: "execute", state: "executing", execution };
	}

	private abandon(): MidCallFeatureStep {
		const swallowed = this.code + this.argument;
		if (this.current !== "idle") {
			assertMidCallFeatureTransition(this.current, "idle");
		}
		const step = this.reset();
		return { ...step, kind: "abandoned", swallowed };
	}

	private reset(): MidCallFeatureStep {
		this.current = INITIAL_MID_CALL_FEATURE_STATE;
		this.code = "";
		this.argument = "";
		this.matched = undefined;
		this.deadlineMs = undefined;
		return { kind: "captured", state: "idle" };
	}

	private arm(kind: MidCallFeatureStepKind, deadlineMs: number): MidCallFeatureStep {
		this.deadlineMs = deadlineMs;
		return { kind, state: this.current, wakeAtMs: deadlineMs };
	}

	private step(kind: MidCallFeatureStepKind): MidCallFeatureStep {
		return this.deadlineMs === undefined
			? { kind, state: this.current }
			: { kind, state: this.current, wakeAtMs: this.deadlineMs };
	}
}
