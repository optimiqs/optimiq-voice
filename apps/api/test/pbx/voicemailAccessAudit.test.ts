import { expect } from "chai";
import { mintVoicemailMediaToken } from "../../src/pbx/voicemail-boxes/voicemail-media-token";
import { VoicemailMessagesService } from "../../src/pbx/voicemail-boxes/voicemail-messages.service";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { VoicemailEmailService } from "../../src/pbx/voicemail-boxes/voicemail-email.service";
import type { VoicemailMwiPublisher } from "../../src/pbx/voicemail-boxes/voicemail-mwi.publisher";
import type { ObjectStore } from "../../src/storage";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The voicemail READ ledger.
 *
 * `audit_log` could already say who forwarded a message and who deleted one, and said nothing at
 * all about who LISTENED to one — which inverts the two facts' weight. A voicemail is somebody's
 * voice saying something to somebody else; a third party hearing it is the event with a data
 * subject attached, and the deletion is comparatively benign.
 *
 * Two rows, for the same reason the recording side has two: minting a playback link is an
 * authorisation this person was granted, and opening the media is a bearer of that credential
 * actually fetching the audio. A link minted and never followed, and a link followed from four
 * different addresses, are both invisible if they are collapsed into one row.
 */

const ORG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const USER = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";
const BOX = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01";
const MESSAGE = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01";
const SECRET = "0123456789abcdef0123456789abcdef";
const KEY = `${ORG}/${MESSAGE}.wav`;

interface LedgerRow {
	readonly action: string;
	readonly resourceType: string;
	readonly resourceRef: string | null;
	readonly actorType: string;
	readonly actorUserId: string | null;
	readonly actorRef: string | null;
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
	readonly after: Record<string, unknown> | null;
}

function env(): PbxEnv {
	return {
		PBX_VOICEMAIL_URL_SECRET: SECRET,
		PBX_VOICEMAIL_URL_TTL_SECONDS: 300,
	} as PbxEnv;
}

function sessionFor(): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER,
			activeOrganizationId: ORG,
			ipAddress: "203.0.113.7",
			userAgent: "Mozilla/5.0 (console)",
		},
		user: { id: USER, email: "u@test", name: "U", emailVerified: true },
		// The unscoped grant, so `assertMayReachBox` short-circuits the `.own` row check — which is
		// a different seam with its own spec (`selfServiceScope.test.ts`) and not what is under test
		// here.
		permissions: ["voicemail.listen"],
	} as unknown as AppSession;
}

/**
 * A `PbxDatabaseClient` whose transaction answers a box, a message, and captures ledger inserts.
 *
 * `insertAuditLog` is four lines of Drizzle; what is worth proving without a database is what
 * REACHES it, which is the decision this service makes.
 */
function fakeDatabase(): { readonly database: PbxDatabaseClient; readonly ledger: LedgerRow[] } {
	const ledger: LedgerRow[] = [];
	const database = {
		withTenantScope: async (
			_organizationId: string,
			run: (transaction: unknown) => Promise<unknown>,
		) => {
			const transaction = {
				select: (shape: Record<string, unknown>) => {
					const rows =
						"mailboxNumber" in shape
							? [
									{
										id: BOX,
										mailboxNumber: "2001",
										extensionNumber: "1001",
										mwiEnabled: false,
									},
								]
							: [
									{
										id: MESSAGE,
										voicemailBoxId: BOX,
										objectKey: KEY,
										receivedAt: new Date("2026-01-02T03:04:05Z"),
										folder: "new",
										durationMs: 1_000,
										sizeBytes: 4_096,
										callerIdName: null,
										callerIdNumber: null,
										transcription: null,
										transcriptionStatus: "disabled",
										transcribedAt: null,
										callLegRef: null,
									},
								];
					const builder = {
						from: () => builder,
						leftJoin: () => builder,
						where: () => builder,
						orderBy: () => builder,
						groupBy: async () => await Promise.resolve([]),
						limit: async () => await Promise.resolve(rows),
					};
					return builder;
				},
				insert: () => ({
					values: async (row: Record<string, unknown>) => {
						ledger.push({
							action: row.action as string,
							resourceType: row.resourceType as string,
							resourceRef: row.resourceRef as string | null,
							actorType: row.actorType as string,
							actorUserId: row.actorUserId as string | null,
							actorRef: row.actorRef as string | null,
							ipAddress: row.ipAddress as string | null,
							userAgent: row.userAgent as string | null,
							after: row.after as Record<string, unknown> | null,
						});
						await Promise.resolve();
					},
				}),
			};
			return await run(transaction);
		},
	} as unknown as PbxDatabaseClient;
	return { database, ledger };
}

function fakeStore(): ObjectStore {
	return {
		driver: "local",
		head: async () => await Promise.resolve({ sizeBytes: 4_096 }),
		getStream: async () => await Promise.resolve({ on: () => undefined }),
	} as unknown as ObjectStore;
}

function serviceWith(database: PbxDatabaseClient): VoicemailMessagesService {
	return new VoicemailMessagesService(
		env(),
		database,
		{} as unknown as VoicemailMwiPublisher,
		fakeStore(),
		{} as unknown as VoicemailEmailService,
	);
}

describe("the voicemail access ledger", () => {
	it("records the AUTHORISATION when a playback link is minted, inside the proving transaction", async () => {
		const { database, ledger } = fakeDatabase();

		await serviceWith(database).mintPlaybackLink(sessionFor(), BOX, MESSAGE);

		expect(ledger).to.have.length(1);
		expect(ledger[0]?.action).to.equal("voicemail-message.play-url");
		expect(ledger[0]?.resourceType).to.equal("voicemail_message");
		expect(ledger[0]?.resourceRef).to.equal(MESSAGE);
		expect(ledger[0]?.actorType).to.equal("user");
		expect(ledger[0]?.actorUserId).to.equal(USER);
		// The session's own address and agent, so the row is attributable without a log join.
		expect(ledger[0]?.ipAddress).to.equal("203.0.113.7");
		expect(ledger[0]?.userAgent).to.equal("Mozilla/5.0 (console)");
		expect(ledger[0]?.after?.expiresInSeconds).to.equal(300);
	});

	it("records the LISTEN as a token bearer, with the address it actually came from", async () => {
		const { database, ledger } = fakeDatabase();
		const token = mintVoicemailMediaToken(
			MESSAGE,
			ORG,
			Math.floor(Date.now() / 1000) + 300,
			SECRET,
		);

		await serviceWith(database).openSignedMedia(token, undefined, {
			ipAddress: "198.51.100.9",
			userAgent: "curl/8",
		});

		expect(ledger).to.have.length(1);
		expect(ledger[0]?.action).to.equal("voicemail-message.play");
		// No person is named. The route is anonymous by construction — an `<audio src>` cannot carry
		// a session — and the minter is frequently not the fetcher, which is why the scheme exists.
		expect(ledger[0]?.actorType).to.equal("system");
		expect(ledger[0]?.actorUserId).to.equal(null);
		expect(ledger[0]?.actorRef).to.equal(`voicemail-token:${MESSAGE}`);
		expect(ledger[0]?.ipAddress).to.equal("198.51.100.9");
		expect(ledger[0]?.userAgent).to.equal("curl/8");
	});

	it("writes nothing for a token that never reached any audio", async () => {
		const { database, ledger } = fakeDatabase();

		await serviceWith(database)
			.openSignedMedia("not-a-token")
			.catch(() => undefined);

		expect(ledger).to.have.length(0);
	});
});
