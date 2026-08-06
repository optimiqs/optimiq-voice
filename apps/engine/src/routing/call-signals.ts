import { Injectable } from "@nestjs/common";
import type { HangupCause } from "@optimiq-voice/telephony";

/**
 * The signal bus between the ARI event handler and the plan walker.
 *
 * ## Why it exists
 *
 * The walker is written as straight-line asynchronous code — "originate, wait for an answer, bridge"
 * — because that is the only shape in which a ring group's lose-race semantics and an IVR's retry
 * counters are readable. But the facts it waits on (a B-leg answered, a B-leg died with cause 17, a
 * recording finished) arrive as ARI events on a socket the orchestrator owns.
 *
 * Something has to join the two, and it is the same problem {@link import("../verbs/dtmf-registry")
 * .DtmfRegistry} already solves for digits: if the orchestrator owned the waiters, the walker would
 * be built from the orchestrator and the orchestrator from the walker. Giving the waiters their own
 * owner makes both depend on it and neither on each other.
 *
 * ## Keys, not channels
 *
 * A signal is addressed by a STRING key rather than by a channel object, because the walker
 * subscribes BEFORE the thing it is waiting for exists. An originate is only safe if the
 * subscription is already in place when the response comes back — a `StasisStart` for a fast local
 * endpoint routinely beats the HTTP reply, and a waiter registered afterwards would miss it.
 */

/** What can happen to a leg the walker originated. */
export type LegSignal =
	| { readonly kind: "ringing" }
	| { readonly kind: "progress" }
	| { readonly kind: "answered" }
	/** The leg reached the Stasis application: it is ours to bridge. */
	| { readonly kind: "entered" }
	| { readonly kind: "ended"; readonly cause: HangupCause; readonly causeCode: number };

/** What can happen to a recording the walker started. */
export type RecordingSignal =
	| { readonly kind: "recording-started" }
	| { readonly kind: "recording-finished"; readonly durationMs: number }
	| { readonly kind: "recording-failed"; readonly reason: string };

export type CallSignal = LegSignal | RecordingSignal;

/** The key a leg's signals are published under. */
export function legSignalKey(mediaChannelId: string): string {
	return `leg:${mediaChannelId}`;
}

/** The key a recording's signals are published under. */
export function recordingSignalKey(name: string): string {
	return `recording:${name}`;
}

type Listener = (signal: CallSignal) => void;

/**
 * A tiny in-process fan-out.
 *
 * Not an `EventEmitter`: Node's emitter turns an exception in one listener into an uncaught
 * exception for the whole process, and these listeners run on the ARI socket's callback path where
 * that would take every live call down with it. A listener that throws here is isolated.
 */
@Injectable()
export class CallSignalBus {
	private readonly listeners = new Map<string, Set<Listener>>();

	/** Keys with at least one waiter. `/healthz` and the specs read it. */
	get watchedKeyCount(): number {
		return this.listeners.size;
	}

	/** Whether anything is waiting on this key — how the orchestrator decides an event is ours. */
	isWatched(key: string): boolean {
		return this.listeners.has(key);
	}

	/** Subscribes. The returned function unsubscribes and is safe to call more than once. */
	watch(key: string, listener: Listener): () => void {
		const existing = this.listeners.get(key);
		if (existing === undefined) {
			this.listeners.set(key, new Set([listener]));
		} else {
			existing.add(listener);
		}
		return () => {
			const set = this.listeners.get(key);
			if (set === undefined) {
				return;
			}
			set.delete(listener);
			if (set.size === 0) {
				this.listeners.delete(key);
			}
		};
	}

	/** Publishes. Unknown keys are silently ignored — most ARI events belong to nobody here. */
	emit(key: string, signal: CallSignal): void {
		const set = this.listeners.get(key);
		if (set === undefined) {
			return;
		}
		// A copy, because a listener may unsubscribe itself (they all do, on a terminal signal)
		// and mutating a Set mid-iteration silently skips entries.
		for (const listener of Array.from(set)) {
			try {
				listener(signal);
			} catch {
				// Isolated on purpose: see the class comment. A waiter that throws loses its own
				// signal, not the call.
			}
		}
	}

	/** Drops every waiter. Used by the drain and by specs. */
	clear(): void {
		this.listeners.clear();
	}
}
