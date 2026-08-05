import { Injectable } from "@nestjs/common";
import { DtmfInbox } from "./dtmf-inbox";

/**
 * The per-channel DTMF queues, as an injectable.
 *
 * It exists to break a cycle rather than to add a layer. The verb executor's `gather` needs
 * somewhere to await digits from; the orchestrator's ARI handler is what pushes them. If the
 * orchestrator owned the queues, the executor's layer would have to be built from the orchestrator
 * and the orchestrator would have to be built from the executor. Giving the queues their own owner
 * makes both depend on it and neither on each other.
 */
@Injectable()
export class DtmfRegistry {
	private readonly inboxes = new Map<string, DtmfInbox>();

	get size(): number {
		return this.inboxes.size;
	}

	/** The queue for a leg, created on first use. */
	forChannel(channelId: string): DtmfInbox {
		const existing = this.inboxes.get(channelId);
		if (existing !== undefined) {
			return existing;
		}
		const created = new DtmfInbox();
		this.inboxes.set(channelId, created);
		return created;
	}

	/** The queue for a leg, without creating one. */
	peek(channelId: string): DtmfInbox | undefined {
		return this.inboxes.get(channelId);
	}

	/** Ends any running collection and forgets the leg's queue. */
	release(channelId: string): void {
		this.inboxes.get(channelId)?.hangup();
		this.inboxes.delete(channelId);
	}

	clear(): void {
		for (const inbox of this.inboxes.values()) {
			inbox.hangup();
		}
		this.inboxes.clear();
	}
}
