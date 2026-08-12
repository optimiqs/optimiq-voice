import { randomUUID } from "node:crypto";

/**
 * The fake carrier's world model.
 *
 * ## Why a stateful fake and not recorded fixtures
 *
 * A pure fixture server answers every request the same way, which cannot express the two
 * properties this integration actually depends on:
 *
 * 1. **You must search before you order** (Telnyx error `85000`). A fixture server would happily
 *    accept an order for a number never searched, so the one carrier rule our API layer must
 *    respect would be untested — and would first be discovered in production, on a paid call.
 * 2. **A number ordered once cannot be ordered again** (`85001`). Ordering is the operation whose
 *    double-execution costs money, so the fake has to be able to *say no the second time*.
 *
 * So the fake keeps state: an inventory of numbers with an availability flag, a set of numbers
 * this session has searched, and the orders/connections/profiles created. The response BODIES are
 * still fixture-shaped — every field name and enum member comes from `reference/telnyx-api.md` —
 * but the behaviour is a small state machine, which is what makes `verify:carrier` a test of our
 * sequencing rather than of our JSON parsing.
 */

export interface FakeNumberInventoryEntry {
	readonly phoneNumber: string;
	readonly countryCode: string;
	readonly nationalDestinationCode: string;
	readonly phoneNumberType: string;
	available: boolean;
	/** Set once ordered, so the release path has something to look up. */
	ownedId?: string;
	connectionId?: string;
}

export interface FakeOrder {
	readonly id: string;
	readonly customerReference: string;
	readonly connectionId?: string;
	status: "pending" | "success" | "failure";
	readonly phoneNumbers: readonly string[];
	readonly createdAt: string;
}

export interface FakeConnection {
	readonly id: string;
	connectionName: string;
	userName: string;
	password: string;
	active: boolean;
	anchorsiteOverride: string;
	dtmfType: string;
	webhookApiVersion: string;
	webhookEventUrl?: string;
	outboundVoiceProfileId?: string;
	outboundChannelLimit?: number;
	readonly createdAt: string;
}

export interface FakeFax {
	readonly id: string;
	readonly direction: "inbound" | "outbound";
	status: string;
	readonly connectionId: string;
	readonly to: string;
	readonly from: string;
	readonly mediaUrl?: string;
	readonly mediaName?: string;
	readonly clientState?: string;
	readonly createdAt: string;
}

export interface FakeProfile {
	readonly id: string;
	name: string;
	enabled: boolean;
	concurrentCallLimit?: number;
	whitelistedDestinations: string[];
	dailySpendLimit?: string;
	dailySpendLimitEnabled: boolean;
	connectionsCount: number;
	readonly createdAt: string;
}

/**
 * A canned inventory, generated rather than hand-listed so a test can ask for a hundred numbers in
 * one area code without a hundred lines of fixture.
 *
 * The numbers are all in the +1-555 range, which is reserved for fiction in the NANP — a fixture
 * that used a real, orderable number would be a copy-paste away from someone pointing this client
 * at the live API and buying it.
 */
export function defaultInventory(): FakeNumberInventoryEntry[] {
	const entries: FakeNumberInventoryEntry[] = [];
	for (const [ndc, country] of [
		["212", "US"],
		["415", "US"],
		["416", "CA"],
	] as const) {
		for (let index = 0; index < 12; index += 1) {
			entries.push({
				phoneNumber: `+1${ndc}555${String(1000 + index).padStart(4, "0")}`,
				countryCode: country,
				nationalDestinationCode: ndc,
				phoneNumberType: "local",
				available: true,
			});
		}
	}
	return entries;
}

export class FakeTelnyxState {
	readonly inventory: FakeNumberInventoryEntry[];
	/** Numbers returned by a search on this instance. The `85000` gate reads this. */
	readonly searched = new Set<string>();
	readonly orders = new Map<string, FakeOrder>();
	readonly connections = new Map<string, FakeConnection>();
	readonly profiles = new Map<string, FakeProfile>();
	readonly faxes = new Map<string, FakeFax>();
	/** Every request the fake saw, so a spec can assert headers and bodies after the fact. */
	readonly requests: {
		method: string;
		path: string;
		headers: Record<string, string>;
		body: unknown;
	}[] = [];

	/**
	 * Statuses to return before behaving normally, consumed one per request.
	 *
	 * This is how the retry spec drives "429, 429, then 200" without a real rate limiter, and it is
	 * a queue rather than a flag so a test can describe an exact failure sequence.
	 */
	readonly failureQueue: { status: number; code?: string; retryAfterSeconds?: number }[] = [];

	constructor(inventory: FakeNumberInventoryEntry[] = defaultInventory()) {
		this.inventory = inventory;
	}

	newId(): string {
		return randomUUID();
	}

	now(): string {
		return new Date().toISOString();
	}

	find(phoneNumber: string): FakeNumberInventoryEntry | undefined {
		return this.inventory.find((entry) => entry.phoneNumber === phoneNumber);
	}

	findOwned(numberId: string): FakeNumberInventoryEntry | undefined {
		return this.inventory.find((entry) => entry.ownedId === numberId);
	}

	/** Queues one synthetic failure. Returns `this` so a test reads as a sentence. */
	failNext(status: number, options: { code?: string; retryAfterSeconds?: number } = {}): this {
		this.failureQueue.push({
			status,
			...(options.code === undefined ? {} : { code: options.code }),
			...(options.retryAfterSeconds === undefined
				? {}
				: { retryAfterSeconds: options.retryAfterSeconds }),
		});
		return this;
	}

	reset(): void {
		this.searched.clear();
		this.orders.clear();
		this.connections.clear();
		this.profiles.clear();
		this.faxes.clear();
		this.requests.length = 0;
		this.failureQueue.length = 0;
		for (const entry of this.inventory) {
			entry.available = true;
			delete entry.ownedId;
			delete entry.connectionId;
		}
	}
}
