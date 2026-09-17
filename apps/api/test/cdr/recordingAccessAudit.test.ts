import { expect } from "chai";
import { mintRecordingToken } from "../../src/cdr/recordings/recording-token";
import { RecordingsService } from "../../src/cdr/recordings/recordings.service";
import type {
	RecordingAccessAudit,
	RecordingAccessAuditEntry,
} from "../../src/cdr/recordings/access-audit";
import type { CdrEnv } from "../../src/cdr/shared/cdr-env";
import type { ObjectStore } from "../../src/storage";
import type { AppSession } from "@optimiq-voice/auth";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * The recording READ ledger.
 *
 * The deletion paths have written to `audit_log` since they existed and the playback paths wrote
 * nothing, which left the ledger able to answer "who destroyed this recording?" and unable to
 * answer "who listened to it?" — and the second is the question a data-protection complaint, an HR
 * dispute and a PCI review all actually ask.
 *
 * Three things are worth proving without a database. That a MINT and an OPEN are two rows and not
 * one, because a link minted and never followed is an authorisation that was never used and a link
 * followed four times is one authorisation and four listens. That a signed-token open records what
 * it actually knows — a `system` actor carrying the token's own subject and the request's address
 * — rather than fabricating the person who minted the link, who is frequently not the fetcher.
 * And that a ledger which refuses the row never costs the listener their audio.
 */

const ORG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const USER = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";
const RECORDING = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a7d";
const SECRET = "0123456789abcdef0123456789abcdef";
const KEY = `${ORG}/call-1/${RECORDING}.wav`;

function env(overrides: Partial<CdrEnv> = {}): CdrEnv {
	return {
		CDR_RECORDING_URL_SECRET: SECRET,
		CDR_RECORDING_URL_TTL_SECONDS: 300,
		...overrides,
	} as CdrEnv;
}

function sessionFor(ip: string | null = "203.0.113.7"): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER,
			activeOrganizationId: ORG,
			ipAddress: ip,
			userAgent: "Mozilla/5.0 (console)",
		},
		user: { id: USER, email: "u@test", name: "U", emailVerified: true },
	} as unknown as AppSession;
}

/** A database whose tenant scope answers one recording row, whatever is asked of it. */
function fakeDatabase(row: Record<string, unknown> | undefined): CdrDatabaseClient {
	return {
		withTenantScope: async (_organizationId: string, run: (t: unknown) => Promise<unknown>) => {
			// The repository reads through a transaction; the row is what it would have found.
			void run;
			return await Promise.resolve(row);
		},
	} as unknown as CdrDatabaseClient;
}

function recordingRow(): Record<string, unknown> {
	return {
		id: RECORDING,
		objectKey: KEY,
		deletedAt: null,
		kind: "call",
		createdAt: new Date("2026-01-02T03:04:05Z"),
	};
}

function fakeStore(): ObjectStore {
	return {
		driver: "local",
		head: async () => await Promise.resolve({ sizeBytes: 4_096 }),
		getStream: async () => await Promise.resolve({ on: () => undefined }),
	} as unknown as ObjectStore;
}

function fakeAudit(refuse = false): RecordingAccessAudit & {
	readonly calls: { organizationId: string; entry: RecordingAccessAuditEntry }[];
} {
	const calls: { organizationId: string; entry: RecordingAccessAuditEntry }[] = [];
	return {
		calls,
		recordAccess: async (organizationId, entry) => {
			if (refuse) {
				throw new Error("the pbx database is unreachable");
			}
			calls.push({ organizationId, entry });
			await Promise.resolve();
		},
	};
}

describe("the recording access ledger", () => {
	it("records the AUTHORISATION when a download link is minted, attributed to the session", async () => {
		const audit = fakeAudit();
		const service = new RecordingsService(env(), fakeDatabase(recordingRow()), fakeStore(), audit);

		await service.mintDownloadLink(sessionFor(), RECORDING);

		expect(audit.calls).to.have.length(1);
		const { organizationId, entry } = audit.calls[0]!;
		expect(organizationId).to.equal(ORG);
		expect(entry.event).to.equal("download-url");
		expect(entry.recordingId).to.equal(RECORDING);
		expect(entry.actor.kind).to.equal("user");
		expect(entry.actor.userId).to.equal(USER);
		expect(entry.actor.ipAddress).to.equal("203.0.113.7");
		// The lifetime is on the row, because "how long was this credential good for" is half of
		// what an investigation into a leaked URL needs.
		expect(entry.detail.expiresInSeconds).to.equal(300);
		expect(entry.detail.objectKey).to.equal(KEY);
	});

	it("records the LISTEN separately, as a token bearer rather than a fabricated user", async () => {
		const audit = fakeAudit();
		const service = new RecordingsService(env(), fakeDatabase(recordingRow()), fakeStore(), audit);
		const token = mintRecordingToken(
			{ r: RECORDING, o: ORG, e: Math.floor(Date.now() / 1000) + 300 },
			SECRET,
		);

		await service.openSignedMedia(token, undefined, {
			ipAddress: "198.51.100.9",
			userAgent: "curl/8",
		});

		expect(audit.calls).to.have.length(1);
		const entry = audit.calls[0]!.entry;
		expect(entry.event).to.equal("play");
		// No person is named, because none is known: this route is anonymous by construction, and
		// the minter and the fetcher are frequently different parties — which is why a leaked link
		// is visible as one address minting and another fetching.
		expect(entry.actor.kind).to.equal("token");
		expect(entry.actor.userId).to.equal(null);
		expect(entry.actor.ref).to.equal(`recording-token:${RECORDING}`);
		expect(entry.actor.ipAddress).to.equal("198.51.100.9");
		expect(entry.actor.userAgent).to.equal("curl/8");
	});

	it("writes nothing for a token that never reached any audio", async () => {
		const audit = fakeAudit();
		const service = new RecordingsService(env(), fakeDatabase(recordingRow()), fakeStore(), audit);

		// A forged signature. Every refusal above the open answers a request that saw no bytes, and
		// a ledger row for each of them would drown the listens in noise a WAF already logs.
		await service.openSignedMedia("not-a-token").catch(() => undefined);

		expect(audit.calls).to.have.length(0);
	});

	it("serves the media even when the ledger refuses the row", async () => {
		const service = new RecordingsService(
			env(),
			fakeDatabase(recordingRow()),
			fakeStore(),
			fakeAudit(true),
		);

		// The listen is authorised and about to happen either way, so the honest failure mode is a
		// gap somebody can grep for — not a player that stops working because an insert did.
		const link = await service.mintDownloadLink(sessionFor(), RECORDING);
		expect(link.data.expiresInSeconds).to.equal(300);
	});

	it("still serves recordings in a deployment with no PBX area behind the port", async () => {
		const service = new RecordingsService(env(), fakeDatabase(recordingRow()), fakeStore());
		const link = await service.mintDownloadLink(sessionFor(), RECORDING);
		expect(link.data.url).to.contain("token=");
	});
});
