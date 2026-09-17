import { expect } from "chai";
import { RecordingRetentionPolicyService } from "../../src/pbx/org-settings/recording-retention-policy.service";
import type { OrgSettingsService } from "../../src/pbx/org-settings/org-settings.service";

/**
 * The TTL cache in front of `org_setting`'s recording retention read.
 *
 * The cache IS the contract: the port was only allowed onto the recording write path on the
 * promise of one foreign-database query per organization per minute rather than one per
 * recording, so these tests count queries the way the objection in `cdr-env.ts` counts them. The
 * clock is injected, because a test that sleeps through a TTL is a test of the scheduler.
 */

const ORG_A = "00000000-0000-7000-8000-0000000000a1";
const ORG_B = "00000000-0000-7000-8000-0000000000b2";

function fakeSettings(answers: Record<string, number | undefined>): {
	readonly settings: OrgSettingsService;
	readonly reads: string[];
	failNext: (error: Error) => void;
} {
	const reads: string[] = [];
	let pendingFailure: Error | undefined;
	const settings = {
		readRecordingRetentionDays: async (organizationId: string) => {
			if (pendingFailure !== undefined) {
				const failure = pendingFailure;
				pendingFailure = undefined;
				throw failure;
			}
			reads.push(organizationId);
			return await Promise.resolve(answers[organizationId]);
		},
	} as unknown as OrgSettingsService;
	return {
		settings,
		reads,
		failNext: (error: Error) => {
			pendingFailure = error;
		},
	};
}

describe("the recording retention policy's TTL cache", () => {
	it("answers from the cache within the TTL — one query per organization, not per recording", async () => {
		let at = 0;
		const { settings, reads } = fakeSettings({ [ORG_A]: 30 });
		const policy = new RecordingRetentionPolicyService(settings, {
			ttlMs: 60_000,
			now: () => at,
		});

		expect(await policy.retentionDaysFor(ORG_A)).to.equal(30);
		at = 59_999;
		expect(await policy.retentionDaysFor(ORG_A)).to.equal(30);
		expect(await policy.retentionDaysFor(ORG_A)).to.equal(30);

		// Both record events of every call in a minute's burst cost exactly one settings read.
		expect(reads).to.deep.equal([ORG_A]);
	});

	it("re-reads once the TTL has elapsed, so a saved window takes effect within a minute", async () => {
		let at = 0;
		const answers: Record<string, number | undefined> = { [ORG_A]: 30 };
		const { settings, reads } = fakeSettings(answers);
		const policy = new RecordingRetentionPolicyService(settings, {
			ttlMs: 60_000,
			now: () => at,
		});

		expect(await policy.retentionDaysFor(ORG_A)).to.equal(30);
		answers[ORG_A] = 7;
		at = 60_000;
		expect(await policy.retentionDaysFor(ORG_A)).to.equal(7);
		expect(reads).to.deep.equal([ORG_A, ORG_A]);
	});

	it("caches 'never set' on the same terms as a number", async () => {
		// Tenants that never open the settings screen are most of them; an uncached miss would put
		// the per-recording query right back on the write path for exactly the common case.
		let at = 0;
		const { settings, reads } = fakeSettings({});
		const policy = new RecordingRetentionPolicyService(settings, {
			ttlMs: 60_000,
			now: () => at,
		});

		expect(await policy.retentionDaysFor(ORG_A)).to.equal(undefined);
		expect(await policy.retentionDaysFor(ORG_A)).to.equal(undefined);
		expect(reads).to.deep.equal([ORG_A]);
	});

	it("caches per organization — one tenant's window never answers for another", async () => {
		const { settings, reads } = fakeSettings({ [ORG_A]: 30, [ORG_B]: 0 });
		const policy = new RecordingRetentionPolicyService(settings, {
			ttlMs: 60_000,
			now: () => 0,
		});

		expect(await policy.retentionDaysFor(ORG_A)).to.equal(30);
		// An explicit 0 is the tenant's answer (keep for ever), NOT "unset" — it must round-trip.
		expect(await policy.retentionDaysFor(ORG_B)).to.equal(0);
		expect(reads).to.deep.equal([ORG_A, ORG_B]);
	});

	it("does not cache a failing read — the next recording retries instead of freezing an error", async () => {
		let at = 0;
		const { settings, reads, failNext } = fakeSettings({ [ORG_A]: 30 });
		const policy = new RecordingRetentionPolicyService(settings, {
			ttlMs: 60_000,
			now: () => at,
		});

		failNext(new Error("pbx-db is unreachable"));
		let thrown: unknown;
		try {
			await policy.retentionDaysFor(ORG_A);
		} catch (error) {
			thrown = error;
		}
		// The throw reaches the caller, which falls back to the platform floor for THAT recording.
		expect(String(thrown)).to.contain("unreachable");

		expect(await policy.retentionDaysFor(ORG_A)).to.equal(30);
		expect(reads).to.deep.equal([ORG_A]);
	});
});
