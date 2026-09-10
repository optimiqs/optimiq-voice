/**
 * The waiter side of a prompt's ENDING, for the one caller that genuinely needs it.
 *
 * ## Why this exists at all
 *
 * `MediaPort.play` returns as soon as audio has STARTED — the verb executor says so in as many
 * words, because barge-in must not hold a fiber for the length of a prompt — so nothing above the
 * media seam has ever known whether a prompt was actually delivered. For every prompt on the
 * platform that is the right trade: an IVR greeting the caller talks over is a greeting that did
 * its job, and a menu the caller never hears fails visibly one keypress later.
 *
 * The consent announcement is the exception, and it is the exception because of what is written
 * down afterwards. `CallControl.announceConsent` produces a compliance record naming the parties
 * the prompt reached, and that record was previously stamped on the strength of `play` RESOLVING —
 * which on a WebRTC party whose ICE and DTLS had not finished meant `mediad` wrote 52 frames into a
 * transport with no peer, logged `playedMs 0`, and the record still said the party was announced
 * to. A record that can be wrong about the only claim it exists to make is worse than no record.
 *
 * `mediad` has always published the fact — `media.evt.v1.…playback.finished`, carrying `playedMs`
 * and a reason — and the engine simply dropped it at the mapping. This bus is where it lands now.
 *
 * ## Why a bus of its own and not {@link import("../routing/call-signals").CallSignalBus}
 *
 * The two are the same shape and deliberately so. They are kept apart because a playback signal is
 * not a fact about a LEG or a RECORDING: it is keyed by the playback reference the caller assigned,
 * so two prompts running on one channel (an announcement and the hold music behind it) never see
 * each other's completion. Keying a playback on the leg's key would have made those two
 * indistinguishable, which is exactly the failure this whole change exists to stop.
 *
 * Ownership follows that: `ChannelOrchestrator` constructs one and hands it to the `CallControl` it
 * builds, so there is exactly one instance per engine, with no Nest provider and no positional
 * constructor argument for the spec harnesses to fake.
 */

/**
 * A prompt this engine started has stopped.
 *
 * `playedMs` is the field the whole rung was carried for: how much audio actually reached the far
 * end, which is a number only the process that wrote the packets can know. It is OPTIONAL because
 * one driver genuinely cannot report it — Asterisk's `PlaybackFinished` carries a state and no
 * duration — and a consumer must be able to tell "nothing was delivered" (`0`) from "this media
 * plane does not measure delivery" (absent). Treating the second as the first would refuse every
 * announcement on an ARI deployment.
 */
export interface PlaybackFinishedSignal {
	readonly kind: "playback-finished";
	readonly playbackRef: string;
	/** How much audio reached the far end, in ms. Absent when the driver cannot measure it. */
	readonly playedMs?: number;
	/** The media plane's own word for why it stopped (`completed`, `stopped`, `error`, `failed`). */
	readonly reason: string;
	/** Free text for a failure, when the media plane volunteered any. */
	readonly detail?: string;
}

export type PlaybackSignal = PlaybackFinishedSignal;

/**
 * The key a playback's signals are published under.
 *
 * The REFERENCE, not the channel: the caller assigns it on `play`, `mediad` echoes it back on
 * `playback.finished`, and ARI's playback id is the same string. See the file header for why a
 * channel key would have been wrong.
 */
export function playbackSignalKey(playbackRef: string): string {
	return `playback:${playbackRef}`;
}

type Listener = (signal: PlaybackSignal) => void;

/**
 * A tiny in-process fan-out, isolated per listener.
 *
 * Not an `EventEmitter`, for the reason `CallSignalBus` gives: Node's emitter turns an exception in
 * one listener into an uncaught exception for the whole process, and these listeners run on the
 * media event socket's callback path where that would take every live call down with it.
 */
export class PlaybackSignalBus {
	private readonly listeners = new Map<string, Set<Listener>>();

	/** Keys with at least one waiter. The specs read it to prove no watcher was left behind. */
	get watchedKeyCount(): number {
		return this.listeners.size;
	}

	/** Whether anything is waiting on this key. */
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

	/**
	 * Publishes. Unknown keys are silently ignored — almost every playback on this platform
	 * (greetings, menus, music) has no waiter, which is the normal case and not an error.
	 */
	emit(key: string, signal: PlaybackSignal): void {
		const set = this.listeners.get(key);
		if (set === undefined) {
			return;
		}
		// A copy, because a listener unsubscribes itself on its terminal signal and mutating a Set
		// mid-iteration silently skips entries.
		for (const listener of Array.from(set)) {
			try {
				listener(signal);
			} catch {
				// Isolated on purpose: see the class comment.
			}
		}
	}

	/** Drops every waiter. Used by the drain and by specs. */
	clear(): void {
		this.listeners.clear();
	}
}
