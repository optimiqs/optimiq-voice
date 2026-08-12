import { getLogger } from "@optimiq-voice/logging";
import { MidCallFeatureMachine } from "@optimiq-voice/telephony";
import type {
	CallControlResult,
	ControlledLeg,
	ParkOutcome,
	RecordingOutcome,
	TransferRequest,
} from "./call-control";
import type { CompiledFeatureCode, RoutingArtifact } from "@optimiq-voice/routing";
import type {
	DtmfDigit,
	MidCallFeatureAction,
	MidCallFeatureCode,
	MidCallFeatureExecution,
	MidCallFeatureSettings,
} from "@optimiq-voice/telephony";

/**
 * Mid-call feature codes: `*1` to transfer, `*3` to record, `*5` to park, the cancel key to back out.
 *
 * ## Why this is not the verb executor's `gather`
 *
 * A `gather` is an application ASKING for digits: it owns the leg, it knows a collection is running,
 * and every digit that arrives belongs to it. This is the opposite situation. Nobody has asked for
 * anything, the party is in the middle of a conversation, and the overwhelming majority of digits
 * they press are meant for the person on the other end — a remote IVR, a conference bridge, an
 * outside voicemail system. The decision to STOP passing a digit through has to be made on the first
 * one, before anybody knows what the code will turn out to be.
 *
 * So the rules live in `packages/telephony`'s {@link MidCallFeatureMachine} — pure, table-driven,
 * `idle → armed → collecting → executing` with an inter-digit timeout — and this class is the three
 * things the machine cannot be: the clock, the per-leg registry, and the map from an abstract action
 * to the call-control operation that performs it.
 *
 * ## Where the codes come from
 *
 * The tenant's OWN catalogue, out of the compiled routing artifact's `internal.featureCodes`. A
 * tenant who renumbered `*1` to `*7` gets `*7` mid-call too, which is the only defensible answer: a
 * mid-call table with its own hard-coded numbering would disagree with the star codes printed on
 * every user's cheat sheet.
 *
 * Only three compiled actions have a mid-call runtime — `transfer`, `record-toggle` and
 * `call-park` — and the rest are deliberately not offered. `*72` call-forward and `*78` DND are
 * configuration changes, and `*97` is a destination; a party in the middle of a conversation reaches
 * those by making a second call, exactly as they would on any other system.
 *
 * ## Per-organization enable/disable: ON, and why
 *
 * The compiled settings (`CompiledRoutingSettings`) carry a timezone, the outbound kill switch and
 * the outbound caller id, and nothing about feature codes — `pbx-db` has no per-organization
 * mid-call toggle to compile. So the choice here is DEFAULT-ON, recorded rather than left implicit:
 *
 * - A tenant who does not want a code can DELETE IT from their catalogue, and the code then does not
 *   reach this table at all. That is already a per-organization switch, it is the one the admin UI
 *   exposes, and it is per-code rather than all-or-nothing.
 * - Off-by-default would mean `*1` doing nothing on every existing tenant with no way to discover
 *   why, which is indistinguishable from the feature being broken.
 *
 * When a real `settings.midCallFeatureCodesEnabled` column exists, {@link MidCallFeatureRuntime.tableFor}
 * is the single place that has to read it.
 *
 * ## SIP REFER is NOT this
 *
 * A phone with a hardware transfer key sends `REFER`, which arrives at the SIP edge and never
 * reaches the media server as DTMF. Nothing here helps with it. That is `apps/sipd`'s, later, and it
 * is recorded here because "mid-call transfer works" and "the transfer button on the phone works"
 * are two different claims and only the first one is true.
 */

/** The slice of call control a feature code drives. `CallControl` satisfies it structurally. */
export interface MidCallFeatureControl {
	transfer(leg: ControlledLeg, request: TransferRequest): Promise<CallControlResult>;
	cancelTransfer(leg: ControlledLeg): Promise<CallControlResult>;
	hasPendingTransfer(mediaChannelId: string): boolean;
	park(leg: ControlledLeg, request?: { readonly orbit?: string }): Promise<ParkOutcome>;
	startRecording(leg: ControlledLeg): Promise<RecordingOutcome>;
	stopRecording(leg: ControlledLeg): Promise<CallControlResult>;
	recordingFor(mediaChannelId: string): { readonly recordingId: string } | undefined;
}

/**
 * The compiled actions that have a mid-call runtime, and what they become.
 *
 * A map rather than a `switch` so the set is enumerable: "which star codes work mid-call?" is a
 * question the admin UI will eventually ask, and it should read the answer rather than restate it.
 */
export const MID_CALL_ACTION_BY_COMPILED_ACTION: Readonly<Record<string, MidCallFeatureAction>> = {
	transfer: "blind-transfer",
	"record-toggle": "record-toggle",
	"call-park": "park",
};

export interface MidCallFeatureDependencies {
	readonly control: MidCallFeatureControl;
	/** The organization's compiled artifact, or `undefined` when it cannot be read. */
	readonly artifactFor: (organizationId: string) => Promise<RoutingArtifact | undefined>;
	readonly settings?: Partial<MidCallFeatureSettings>;
	readonly now?: () => number;
	/** Injected so a spec drives the inter-digit timeout without waiting for it. */
	readonly setTimer?: (fn: () => void, ms: number) => { readonly cancel: () => void };
	readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

interface LegCapture {
	readonly machine: MidCallFeatureMachine;
	timer: { readonly cancel: () => void } | undefined;
	/** The cancel key the table was built with, so a change rebuilds the machine. */
	readonly cancelKey: DtmfDigit | undefined;
}

/** What the orchestrator does with the digit it just offered. */
export type MidCallDigitOutcome = "pass-through" | "consumed";

export class MidCallFeatureRuntime {
	private readonly logger = getLogger("engine.mid-call-features");
	private readonly captures = new Map<string, LegCapture>();
	private readonly cancelKeys = new Map<string, DtmfDigit>();
	/**
	 * One in-flight chain per leg, so digits are decided in the order they were pressed.
	 *
	 * {@link offer} has to `await` (the table comes from the artifact, which is fetched on a cache
	 * miss), and ARI events are dispatched concurrently — one `void handleEvent` per event, so that
	 * one channel's work never queues behind another's. Without this chain, two digits pressed a few
	 * milliseconds apart could be decided out of order, and `*1` followed by `2` could resolve as `2`
	 * then `*1`. The machine would then see a `2` in `idle` (passed through to the far end) and a `*1`
	 * that collects nothing.
	 *
	 * Per LEG rather than global: serialising across channels would put every call's DTMF behind
	 * every other call's, which is the thing the concurrent dispatch exists to avoid.
	 */
	private readonly chains = new Map<string, Promise<unknown>>();
	/** Identity tokens invalidated by release, including while an artifact lookup is awaiting. */
	private readonly lifecycles = new Map<string, object>();
	/** `clear` is the drain boundary: no later event may restart feature work. */
	private stopped = false;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => { readonly cancel: () => void };
	private readonly log: (message: string, detail?: Record<string, unknown>) => void;

	constructor(private readonly deps: MidCallFeatureDependencies) {
		this.now = deps.now ?? Date.now;
		this.log = deps.log ?? ((message, detail) => this.logger.debug(detail ?? {}, message));
		this.setTimer =
			deps.setTimer ??
			((fn, ms) => {
				const timer = setTimeout(fn, ms);
				timer.unref?.();
				return { cancel: () => clearTimeout(timer) };
			});
	}

	/** Legs with a capture in progress. `/healthz` and the specs read it. */
	get activeCaptureCount(): number {
		let count = 0;
		for (const capture of this.captures.values()) {
			if (capture.machine.isCapturing) {
				count += 1;
			}
		}
		return count;
	}

	/**
	 * Arms the attended-transfer cancel key for a leg.
	 *
	 * The key comes from the `transfer` verb that started the consultation
	 * (`TransferVerb.cancelKey`), so it is per-transfer rather than per-tenant, and it is a single
	 * digit that must beat every other interpretation while a consult is live. Arming it rebuilds the
	 * leg's table, which is why the machine is cached WITH the key it was built for.
	 */
	armCancelKey(mediaChannelId: string, digit: DtmfDigit): void {
		if (this.stopped) {
			return;
		}
		this.cancelKeys.set(mediaChannelId, digit);
		this.dropCapture(mediaChannelId);
	}

	/** Disarms it. Called when the consultation completes, is cancelled, or the leg goes away. */
	disarmCancelKey(mediaChannelId: string): void {
		if (this.cancelKeys.delete(mediaChannelId)) {
			this.dropCapture(mediaChannelId);
		}
	}

	/**
	 * Offers a digit from the media server.
	 *
	 * Returns whether the runtime CONSUMED it. A consumed digit must not reach the far end and must
	 * not reach the DTMF inbox — the first would send half a feature code to whoever the party is
	 * talking to, and the second would let a later `gather` collect digits the caller pressed for us.
	 *
	 * The action itself is started but NOT awaited: a blind transfer walks a routing plan and rings a
	 * phone, and the ARI event loop that delivered this digit cannot wait for that. The machine stays
	 * in `executing` until the operation settles, which is what stops a second capture starting from
	 * the digits an impatient party presses while they wait.
	 */
	async offer(leg: ControlledLeg, digit: string): Promise<MidCallDigitOutcome> {
		if (this.stopped) {
			return "pass-through";
		}
		const lifecycle = this.lifecycles.get(leg.mediaChannelId) ?? {};
		this.lifecycles.set(leg.mediaChannelId, lifecycle);
		const previous = this.chains.get(leg.mediaChannelId) ?? Promise.resolve();
		const next = previous.then(async () =>
			this.isCurrent(leg, lifecycle) ? await this.decide(leg, digit, lifecycle) : "pass-through",
		);
		// `catch` on the CHAIN only, not on what the caller awaits: a rejection must not stall every
		// subsequent digit on this leg, and the caller still sees its own failure.
		this.chains.set(
			leg.mediaChannelId,
			next.catch(() => undefined),
		);
		return await next;
	}

	private async decide(
		leg: ControlledLeg,
		digit: string,
		lifecycle: object,
	): Promise<MidCallDigitOutcome> {
		const capture = await this.captureFor(leg, lifecycle);
		if (capture === undefined || !this.isCurrent(leg, lifecycle)) {
			return "pass-through";
		}

		const step = capture.machine.push(digit, this.now());
		this.rearm(leg, capture, step.wakeAtMs, lifecycle);

		switch (step.kind) {
			case "pass-through":
				return "pass-through";
			case "captured":
				return "consumed";
			case "abandoned":
				this.log("a mid-call feature code came to nothing", {
					mediaChannelId: leg.mediaChannelId,
					swallowed: step.swallowed,
				});
				return "consumed";
			case "execute":
				void this.run(leg, capture, step.execution as MidCallFeatureExecution, lifecycle);
				return "consumed";
		}
	}

	/** Forgets a leg's capture. Called when the leg goes away, and by the drain. */
	release(mediaChannelId: string): void {
		this.lifecycles.delete(mediaChannelId);
		this.cancelKeys.delete(mediaChannelId);
		this.chains.delete(mediaChannelId);
		this.dropCapture(mediaChannelId);
	}

	/** Drops every capture. Used by the drain and by specs. */
	clear(): void {
		this.stopped = true;
		this.lifecycles.clear();
		// A snapshot: `dropCapture` deletes from the map it is iterating.
		for (const mediaChannelId of Array.from(this.captures.keys())) {
			this.dropCapture(mediaChannelId);
		}
		this.cancelKeys.clear();
		this.chains.clear();
	}

	/**
	 * The table for a leg: the tenant's own codes, plus the cancel key when one is armed.
	 *
	 * The cancel key is added as a one-character code, which puts it through the same longest-first
	 * matching as everything else. That is what makes `*` as a cancel key coexist with `*1` as a
	 * transfer: pressing `*` alone cancels on the code timeout, pressing `*1` transfers, and neither
	 * needs a special case.
	 */
	async tableFor(
		organizationId: string,
		cancelKey?: DtmfDigit,
	): Promise<readonly MidCallFeatureCode[]> {
		const artifact = await this.deps.artifactFor(organizationId);
		const table: MidCallFeatureCode[] = [];

		for (const entry of artifact?.internal.featureCodes ?? []) {
			const action = MID_CALL_ACTION_BY_COMPILED_ACTION[(entry as CompiledFeatureCode).action];
			if (action === undefined) {
				continue;
			}
			table.push({ code: entry.code, action });
		}
		if (cancelKey !== undefined) {
			table.push({ code: cancelKey, action: "cancel" });
		}
		return table;
	}

	// -------------------------------------------------------------------------------------------

	/**
	 * The machine for a leg, built on first use.
	 *
	 * `undefined` — and therefore no interception at all — for a leg that is not BRIDGED. That gate
	 * is the whole safety story of this feature: a leg walking an IVR, listening to a greeting or
	 * leaving voicemail is a leg whose digits belong to the application, and intercepting a `*` there
	 * would break every menu that uses one.
	 */
	private async captureFor(leg: ControlledLeg, lifecycle: object): Promise<LegCapture | undefined> {
		if (!this.isCurrent(leg, lifecycle)) {
			return undefined;
		}
		const cancelKey = this.cancelKeys.get(leg.mediaChannelId);
		const existing = this.captures.get(leg.mediaChannelId);
		if (existing !== undefined && existing.cancelKey === cancelKey) {
			return existing;
		}

		const table = await this.tableFor(leg.organizationId, cancelKey);
		if (table.length === 0 || !this.isCurrent(leg, lifecycle)) {
			return undefined;
		}
		const capture: LegCapture = {
			machine: new MidCallFeatureMachine(table, this.deps.settings ?? {}),
			timer: undefined,
			cancelKey,
		};
		this.captures.set(leg.mediaChannelId, capture);
		return capture;
	}

	/** Re-arms the leg's inter-digit timer, or cancels it when the machine wants none. */
	private rearm(
		leg: ControlledLeg,
		capture: LegCapture,
		wakeAtMs: number | undefined,
		lifecycle: object,
	): void {
		capture.timer?.cancel();
		capture.timer = undefined;
		if (wakeAtMs === undefined || !this.isCurrent(leg, lifecycle)) {
			return;
		}
		const delay = Math.max(0, wakeAtMs - this.now());
		capture.timer = this.setTimer(() => {
			if (!this.isCurrent(leg, lifecycle)) {
				return;
			}
			capture.timer = undefined;
			const step = capture.machine.expire(wakeAtMs);
			this.rearm(leg, capture, step.wakeAtMs, lifecycle);
			if (step.kind === "execute") {
				void this.run(leg, capture, step.execution as MidCallFeatureExecution, lifecycle);
			} else if (step.kind === "abandoned") {
				this.log("a mid-call feature code timed out", {
					mediaChannelId: leg.mediaChannelId,
					swallowed: step.swallowed,
				});
			}
		}, delay);
	}

	/**
	 * Runs one action, then settles the machine.
	 *
	 * `finally`, always: a machine left in `executing` because an operation threw would swallow every
	 * subsequent digit on that leg for the rest of the call, which is the worst failure this feature
	 * can produce — the party can no longer type anything at the far end and has no way to recover
	 * short of hanging up.
	 */
	private async run(
		leg: ControlledLeg,
		capture: LegCapture,
		execution: MidCallFeatureExecution,
		lifecycle: object,
	): Promise<void> {
		if (!this.isCurrent(leg, lifecycle)) {
			return;
		}
		try {
			const result = await this.perform(leg, execution);
			if (!result.ok) {
				this.log("a mid-call feature code was refused", {
					mediaChannelId: leg.mediaChannelId,
					code: execution.code,
					action: execution.action,
					reason: result.reason,
				});
			}
		} catch (error) {
			this.log("a mid-call feature code failed", {
				mediaChannelId: leg.mediaChannelId,
				code: execution.code,
				err: String(error),
			});
		} finally {
			if (this.isCurrent(leg, lifecycle)) {
				capture.machine.settle();
			}
		}
	}

	private async perform(
		leg: ControlledLeg,
		execution: MidCallFeatureExecution,
	): Promise<CallControlResult> {
		const control = this.deps.control;

		switch (execution.action) {
			case "blind-transfer":
				// The existing transfer path, unchanged: the transferee is held, re-routed through the
				// ordinary routing walk, and gets a proper B-leg with its own CDR. A mid-call code must
				// not be a second, subtly different transfer.
				return await control.transfer(leg, {
					kind: "blind",
					destination: execution.argument,
				});

			case "record-toggle": {
				// The toggle reads the CURRENT recording rather than remembering whether it started one:
				// a recording begun by a policy, by a verb or by the other party's own `*3` must all be
				// stoppable by this key, or a compliance recording outlives the call it was on.
				if (control.recordingFor(leg.mediaChannelId) !== undefined) {
					return await control.stopRecording(leg);
				}
				const started = await control.startRecording(leg);
				return started.result;
			}

			case "park": {
				const outcome = await control.park(
					leg,
					execution.argument === "" ? {} : { orbit: execution.argument },
				);
				return outcome.result;
			}

			case "cancel":
				if (!control.hasPendingTransfer(leg.mediaChannelId)) {
					// The consult already ended — the target answered and the transferor completed it, or
					// the transferee hung up. Refusing quietly rather than inventing an operation.
					return { ok: false, reason: "this leg has no transfer to cancel" };
				}
				return await control.cancelTransfer(leg);
		}
	}

	private dropCapture(mediaChannelId: string): void {
		const capture = this.captures.get(mediaChannelId);
		if (capture === undefined) {
			return;
		}
		capture.timer?.cancel();
		capture.machine.cancel();
		this.captures.delete(mediaChannelId);
	}

	private isCurrent(leg: ControlledLeg, lifecycle: object): boolean {
		return (
			!this.stopped &&
			this.lifecycles.get(leg.mediaChannelId) === lifecycle &&
			!leg.isTearingDown &&
			leg.isAnswered &&
			leg.bridgeId !== undefined
		);
	}
}
