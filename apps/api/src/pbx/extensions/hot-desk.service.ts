import { Inject, Injectable } from "@nestjs/common";
import { runEffect } from "@optimiq-voice/effect-runtime";
import { getLogger } from "@optimiq-voice/logging";
import {
	and,
	asc,
	device,
	deviceLine,
	eq,
	extension,
	isNotNull,
	lte,
	pinSet,
	pinSetEntry,
} from "@optimiq-voice/pbx-db";
import { DEVICE_LINE_RESOURCE } from "../../provisioning/devices/devices.resource";
import { serviceActor } from "../shared/audit-log";
import { PBX_DATABASE, PBX_EFFECT_RUNTIME, PBX_ENV } from "../shared/pbx.tokens";
import { verifyVoicemailPin } from "../voicemail-boxes/voicemail-pin.service";
import type { PbxEnv } from "../shared/pbx-env";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { HotDeskRequest, HotDeskResponse } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * Hot desking — an agent claiming a shared desk phone with `*31`, and giving it back with `*32`.
 *
 * ## What actually moves, and what deliberately does not
 *
 * ONE column moves: `device_line.extension_id`, the line's binding. Everything else about the
 * handset stays exactly where it was, and the most important of those is the CREDENTIAL. The phone
 * keeps the SIP account it was provisioned with, keeps its digest username, keeps its HA1, and
 * never re-provisions or re-REGISTERs to stay authenticated — because
 * `sip-credentials.service.ts` resolves a registration against `coalesce(home_extension_id,
 * extension_id)` rather than against the live binding. That indirection is the whole reason
 * `home_extension_id` is a column and not a computed guess; without it, rebinding a line whose
 * `auth_user` is NULL would change the username the phone answers to and take it off the register
 * mid-shift, which is a hot-desk feature that unplugs the phone it is run on.
 *
 * ## The PIN is verified here and is never compiled
 *
 * The engine gathers the digits — the same gather an outbound authorisation code uses — and sends
 * them on `rpc.pbx.v1.hot-desk`. They are checked HERE, against `pin_set_entry.pin_hash`, with the
 * same constant-time verifier the mailbox and conference gates use. The alternative, a compiled
 * hot-desk gate carried in the routing artifact, would broadcast every agent's digest to every
 * engine in the deployment over a KV bucket; a PIN whose only reader is the process that owns the
 * row is a PIN that a leaked artifact does not contain.
 *
 * `extension.hot_desk_pin_set_id` is what says which codes may claim WHICH extension. NULL fails
 * closed: an extension nobody configured a set for cannot be claimed at all. An ungated login would
 * let anybody in the building take anybody's calls by knowing their extension number, which is a
 * number printed on the phone.
 *
 * ## Every refusal is one refusal
 *
 * "No such extension", "that extension is not hot-deskable" and "wrong PIN" all return the same
 * `applied: false` to the handset. Over a phone line the pair (extension, outcome) is an oracle:
 * telling a caller that 1104 exists but the PIN was wrong is how a tenant's extension list gets
 * enumerated from the lobby phone. The distinguishing detail goes to the log, where the person who
 * is allowed to know can find it.
 *
 * ## The write goes back through the repository
 *
 * `affectsRouting("device_line")` is true as of hot desking (`cache.ts` carries the argument), so
 * `updateChild` is what gives this the ledger row, the compile-on-write in the SAME transaction,
 * and — through the mutation seam — the SIP credential-cache eviction that tells `apps/sipd` to
 * re-read. Reimplementing any of that here would be a second write path to a routing input.
 *
 * @throws never. A caller is listening to silence while this runs.
 */
@Injectable()
export class HotDeskService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(PBX_EFFECT_RUNTIME) private readonly runtime: PbxRepositoryRuntime,
		@Inject(PBX_ENV) private readonly env: PbxEnv,
	) {}

	async applyForBroker(request: HotDeskRequest): Promise<HotDeskResponse> {
		return request.action === "login" ? await this.login(request) : await this.logout(request);
	}

	private async login(request: HotDeskRequest): Promise<HotDeskResponse> {
		const number = request.extensionNumber?.trim() ?? "";
		const pin = request.pin ?? "";
		if (number === "" || pin === "") {
			return refuse("login", "the request carried no extension number or no PIN");
		}

		const claim = await this.database.withTenantScope(request.orgId, async (transaction) => {
			const line = await this.lineFor(transaction, request.deviceId);
			// A line with no binding at all is refused rather than adopted. `extension_id` is
			// `ON DELETE SET NULL`, so this is a line whose extension was deleted underneath it: there
			// is no home to remember and therefore no session that could ever be ended.
			if (line === undefined || line.extensionId === null) {
				return { kind: "no-line" as const };
			}
			const homeExtensionId = line.homeExtensionId ?? line.extensionId;
			const target = await this.claimableExtension(transaction, number);
			if (target === undefined) {
				return { kind: "no-extension" as const };
			}
			const digests = await this.pinDigests(transaction, target.hotDeskPinSetId);
			return { kind: "found" as const, line, homeExtensionId, target, digests };
		});

		if (claim.kind === "no-line") {
			return refuse("login", `device ${request.deviceId} has no enabled line to rebind`);
		}
		if (claim.kind === "no-extension") {
			return refuse("login", `no enabled, hot-deskable extension ${number} in this organization`);
		}
		if (claim.digests.length === 0) {
			// A set that exists and has no usable code in it. Distinguished from "no set" ONLY in this
			// log line, because to the agent standing at the desk they are the same refusal.
			return refuse("login", `the PIN set gating extension ${number} has no enabled code in it`);
		}
		if (!(await matchesAnyDigest(pin, claim.digests))) {
			logger.warn(
				{ orgId: request.orgId, deviceId: request.deviceId, callId: request.callId },
				"a hot-desk login failed its PIN challenge",
			);
			return refuse("login", "the PIN did not match any code in the set");
		}

		const { line, homeExtensionId, target } = claim;
		/**
		 * The home binding is captured only on the FIRST login, which is what `?? line.extensionId`
		 * says: a second login onto a desk somebody is already sitting at hands the phone to the new
		 * agent and still returns to the phone's OWN extension. Taking the current binding as the home
		 * every time would make the previous occupant's extension the "home" of a phone that is not
		 * theirs, and the next logout would leave their calls ringing a desk they had walked away from.
		 *
		 * It is also the same call for a re-login onto the extension already bound, which REFRESHES the
		 * expiry — pressing the key again is how an agent extends a session that is about to lapse, and
		 * refusing it because nothing moved would be a confusing answer to a correct PIN.
		 */
		return await this.rebind(request, line, target, homeExtensionId);
	}

	private async logout(request: HotDeskRequest): Promise<HotDeskResponse> {
		const line = await this.database.withTenantScope(
			request.orgId,
			async (transaction) => await this.lineFor(transaction, request.deviceId),
		);
		if (line === undefined) {
			return refuse("logout", `device ${request.deviceId} has no enabled line`);
		}
		if (line.homeExtensionId === null) {
			// Not logged in. Answered as APPLIED, not refused: the agent asked for the phone to be its
			// own again and it already is, and a handset that says "not available" to a logout teaches
			// people to keep pressing it.
			const home =
				line.extensionId === null
					? undefined
					: await this.numberOf(request.orgId, line.extensionId);
			return applied("logout", home);
		}

		const restored = await this.restore(request.orgId, line, "engine.feature-code", request.callId);
		return restored === undefined
			? refuse("logout", "the binding could not be restored")
			: applied("logout", restored);
	}

	/**
	 * Puts a line back on its home binding and clears the session.
	 *
	 * Shared with the sweeper, which is the point: an expiry and a dialled logout must leave the row
	 * in the SAME state, and two implementations of "restore" would be two chances for one of them
	 * to leave `home_extension_id` set on a line that is no longer hot-desked — a line that would
	 * then never be restorable again.
	 *
	 * Returns the extension number the line landed on, or `undefined` when the write failed.
	 */
	async restore(
		organizationId: string,
		line: HotDeskLine,
		actorRef: string,
		callId?: string,
	): Promise<string | undefined> {
		const home = line.homeExtensionId;
		if (home === null) {
			// Nothing to restore — the line is already on its home binding. Answering with the number it
			// is on keeps `logout` and a sweep that raced a dialled logout indistinguishable to the
			// caller, which is what makes the two safe to run at the same time.
			return line.extensionId === null
				? undefined
				: await this.numberOf(organizationId, line.extensionId);
		}
		try {
			await runEffect(this.runtime, (repository) =>
				repository.updateChild(
					organizationId,
					DEVICE_LINE_RESOURCE,
					line.deviceId,
					line.id,
					{
						extensionId: home,
						homeExtensionId: null,
						hotDeskExpiresAt: null,
						hotDeskLoginAt: null,
					},
					// A service principal, not a user: nobody was logged in, somebody dialled a star code
					// or a timer fired. `actorRef` is which of the two, and the ledger's `resource_ref`
					// says which line.
					serviceActor(actorRef),
				),
			);
		} catch (error) {
			logger.error(
				{ organizationId, deviceId: line.deviceId, lineId: line.id, callId, error },
				"a hot-desk session could not be restored to its home binding",
			);
			return undefined;
		}
		return await this.numberOf(organizationId, home);
	}

	/** Every line whose session has lapsed, oldest first. Read with RLS bypassed — see the sweeper. */
	async lapsedSessions(now: Date, limit: number): Promise<readonly LapsedSession[]> {
		const rows = await this.database.adminDb
			.select({
				organizationId: deviceLine.organizationId,
				id: deviceLine.id,
				deviceId: deviceLine.deviceId,
				extensionId: deviceLine.extensionId,
				homeExtensionId: deviceLine.homeExtensionId,
			})
			.from(deviceLine)
			.where(and(isNotNull(deviceLine.homeExtensionId), lte(deviceLine.hotDeskExpiresAt, now)))
			.orderBy(asc(deviceLine.hotDeskExpiresAt))
			.limit(limit);
		return rows.map((row) => ({
			organizationId: row.organizationId,
			line: {
				id: row.id,
				deviceId: row.deviceId,
				extensionId: row.extensionId,
				homeExtensionId: row.homeExtensionId,
			},
		}));
	}

	private async rebind(
		request: HotDeskRequest,
		line: HotDeskLine,
		target: { readonly id: string; readonly number: string },
		homeExtensionId: string,
	): Promise<HotDeskResponse> {
		const now = Date.now();
		const expiresAt = new Date(now + this.env.PBX_HOT_DESK_SESSION_SECONDS * 1000);
		try {
			await runEffect(this.runtime, (repository) =>
				repository.updateChild(
					request.orgId,
					DEVICE_LINE_RESOURCE,
					line.deviceId,
					line.id,
					{
						extensionId: target.id,
						homeExtensionId,
						hotDeskExpiresAt: expiresAt,
						hotDeskLoginAt: new Date(now),
					},
					serviceActor("engine.feature-code"),
				),
			);
		} catch (error) {
			logger.error(
				{
					orgId: request.orgId,
					deviceId: request.deviceId,
					lineId: line.id,
					callId: request.callId,
					error,
				},
				"a hot-desk login could not be written",
			);
			return refuse("login", describe(error));
		}
		return applied("login", target.number, expiresAt);
	}

	/**
	 * The line a hot-desk code acts on: the device's lowest enabled line.
	 *
	 * Line 1 and not "every line", deliberately. A multi-line handset's other keys are shared lines,
	 * BLF appearances and a colleague's overflow — moving all of them would take a whole team's
	 * appearances with one agent's login. The primary line is the one the phone dials out on and the
	 * one an agent means by "this phone".
	 */
	private async lineFor(
		transaction: PbxDatabaseTransaction,
		deviceId: string,
	): Promise<HotDeskLine | undefined> {
		const rows = await transaction
			.select({
				id: deviceLine.id,
				deviceId: deviceLine.deviceId,
				extensionId: deviceLine.extensionId,
				homeExtensionId: deviceLine.homeExtensionId,
			})
			.from(deviceLine)
			.innerJoin(device, eq(device.id, deviceLine.deviceId))
			.where(
				and(
					eq(deviceLine.deviceId, deviceId),
					eq(deviceLine.enabled, true),
					eq(device.enabled, true),
					// A shared line is an APPEARANCE of somebody else's line on this phone. Rebinding one
					// would move a call path that belongs to a team, so it is never the hot-desk line.
					eq(deviceLine.sharedLine, false),
				),
			)
			.orderBy(asc(deviceLine.lineNumber))
			.limit(1);
		return rows[0];
	}

	private async claimableExtension(
		transaction: PbxDatabaseTransaction,
		number: string,
	): Promise<
		{ readonly id: string; readonly number: string; readonly hotDeskPinSetId: string } | undefined
	> {
		const rows = await transaction
			.select({
				id: extension.id,
				number: extension.number,
				hotDeskPinSetId: extension.hotDeskPinSetId,
			})
			.from(extension)
			.where(and(eq(extension.number, number), eq(extension.enabled, true)))
			.limit(1);
		const row = rows[0];
		return row === undefined || row.hotDeskPinSetId === null
			? undefined
			: { id: row.id, number: row.number, hotDeskPinSetId: row.hotDeskPinSetId };
	}

	/** The enabled codes in an enabled set, in ordinal order. Digests, never PINs. */
	private async pinDigests(
		transaction: PbxDatabaseTransaction,
		pinSetId: string,
	): Promise<readonly string[]> {
		const rows = await transaction
			.select({ pinHash: pinSetEntry.pinHash })
			.from(pinSetEntry)
			.innerJoin(pinSet, eq(pinSet.id, pinSetEntry.pinSetId))
			.where(
				and(
					eq(pinSetEntry.pinSetId, pinSetId),
					eq(pinSetEntry.enabled, true),
					eq(pinSet.enabled, true),
				),
			)
			.orderBy(asc(pinSetEntry.ordinal));
		return rows.map((row) => row.pinHash);
	}

	private async numberOf(organizationId: string, extensionId: string): Promise<string | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ number: extension.number })
				.from(extension)
				.where(eq(extension.id, extensionId))
				.limit(1);
			return rows[0]?.number;
		});
	}
}

/** One line the sweeper is about to restore, with the tenant it belongs to. */
export interface LapsedSession {
	readonly organizationId: string;
	readonly line: HotDeskLine;
}

/**
 * The four fields a rebind and a restore both need.
 *
 * `extensionId` is nullable because the column is: `device_line.extension_id` is `ON DELETE SET
 * NULL`, so deleting the extension a line was bound to leaves the line with no binding at all. A
 * login refuses such a line (there is nothing to remember as its home) and a restore ignores the
 * field entirely, because what it writes comes from `homeExtensionId`.
 */
export interface HotDeskLine {
	readonly id: string;
	readonly deviceId: string;
	readonly extensionId: string | null;
	readonly homeExtensionId: string | null;
}

/**
 * The entered digits against every enabled code in the set.
 *
 * Every digest is checked even after one has missed, and the loop returns only on a MATCH — the
 * same shape `PlanWalker.matchPinEntry` has, and for the same reason: an implementation that
 * returned on the first mismatch would only ever accept code number one. A KDF error is a MISS
 * rather than an exception, because `verifyVoicemailPin` runs scrypt and a throw out of here would
 * become a broker timeout on a live call — silence, which is the one outcome this responder exists
 * to make impossible.
 */
async function matchesAnyDigest(pin: string, digests: readonly string[]): Promise<boolean> {
	for (const digest of digests) {
		try {
			if (await verifyVoicemailPin(pin, digest)) {
				return true;
			}
		} catch (error) {
			logger.error({ error }, "a hot-desk PIN digest could not be verified");
		}
	}
	return false;
}

function refuse(action: HotDeskRequest["action"], reason: string): HotDeskResponse {
	return { applied: false, action, reason };
}

function applied(
	action: HotDeskRequest["action"],
	extensionNumber: string | undefined,
	expiresAt?: Date,
): HotDeskResponse {
	return {
		applied: true,
		action,
		...(extensionNumber === undefined ? {} : { extensionNumber }),
		...(expiresAt === undefined ? {} : { expiresAt: expiresAt.toISOString() }),
	};
}

function describe(error: unknown): string {
	return `the rebind could not be applied: ${error instanceof Error ? error.message : String(error)}`;
}
