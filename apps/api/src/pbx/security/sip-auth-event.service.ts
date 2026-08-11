import { isIP } from "node:net";
import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { sipAuthEvent } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import type { SipAclScope, SipAuthEventType, PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx.security");

/** One refused attempt, as the surface that refused it saw it. */
export interface SipAuthEventInput {
	readonly organizationId: string;
	readonly eventType: SipAuthEventType;
	readonly scope: SipAclScope;
	/** The transport peer. A hostname or an unparseable value is stored as NULL, not as text. */
	readonly sourceIp?: string | undefined;
	/** The account, extension number or MAC attempted. NEVER a credential or any part of one. */
	readonly accountRef?: string | undefined;
	readonly transport?: string | undefined;
	readonly userAgent?: string | undefined;
	readonly detail?: Record<string, unknown> | undefined;
}

/**
 * The `sip_auth_event` writer — the attack log the parity audit's row 1.25 says has no counterpart
 * anywhere on this platform.
 *
 * ## Best effort, and the opposite trade from the change ledger
 *
 * `AuditLogService` writes INSIDE the mutation's transaction and lets a failed insert fail the
 * user's write, because a committed change with no ledger row is a gap in a record whose whole
 * value is having none. This service makes the opposite trade deliberately, and the asymmetry is
 * the interesting part:
 *
 * A security event is recorded on the path where something has ALREADY been refused. The caller is
 * getting a 404 or a 429 either way. Turning a database hiccup into a different, louder failure on
 * that path would mean an attacker who can make this insert fail can change the response they get —
 * and, worse, that a database under load during an attack (which is when this table is written to
 * hardest) starts producing 500s on a path that was correctly answering 404. So the insert is
 * awaited but its failure is swallowed and logged, and the refusal proceeds.
 *
 * It also opens its own transaction rather than joining one. There is no mutation to join: nothing
 * was changed, which is the point.
 *
 * ## Tenant-scoped, which bounds what can be recorded
 *
 * `withTenantScope` and the table's `WITH CHECK` mean an event can only be written once the tenant
 * is known. `security-schema.ts` states the consequence in full: an attempt against an account that
 * exists nowhere has no organization to file it under, gets a log line and a media-server security
 * record instead, and is deliberately not a row here. The rule mirrors the change ledger's "no
 * actor, no row" — record what can be attributed, log what cannot.
 *
 * ## What never reaches a column
 *
 * No credential, no token, no secret, no digest of one. `accountRef` is an identifier the attacker
 * supplied and `detail` is a small object the refusing surface built by hand — never a request body
 * and never anything derived from a password. A security log that records the passwords people
 * tried is a password file with extra steps.
 */
@Injectable()
export class SipAuthEventService {
	private recorded = 0;
	private failed = 0;

	constructor(@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient) {}

	get stats(): { readonly recorded: number; readonly failed: number } {
		return { recorded: this.recorded, failed: this.failed };
	}

	async record(input: SipAuthEventInput): Promise<void> {
		try {
			await this.database.withTenantScope(input.organizationId, async (transaction) => {
				await transaction.insert(sipAuthEvent).values({
					organizationId: input.organizationId,
					eventType: input.eventType,
					scope: input.scope,
					// `inet` refuses anything that is not an address, and a proxy that reports a hostname
					// is a real deployment. NULL rather than a 22P02 that would be swallowed below and
					// lose the whole event over a field that is not the point of it.
					sourceIp: asAddress(input.sourceIp),
					accountRef: bounded(input.accountRef, 128),
					transport: bounded(input.transport, 16),
					userAgent: bounded(input.userAgent, 256),
					detail: input.detail ?? null,
				});
			});
			this.recorded += 1;
		} catch (cause) {
			this.failed += 1;
			logger.error(
				{
					err: cause,
					organizationId: input.organizationId,
					eventType: input.eventType,
					scope: input.scope,
				},
				"could not record a SIP authentication failure; the refusal itself is unaffected",
			);
		}
	}
}

function asAddress(value: string | undefined): string | null {
	if (value === undefined || value === "") {
		return null;
	}
	return isIP(value) === 0 ? null : value;
}

/**
 * A caller-supplied string, truncated.
 *
 * The columns are unbounded `text`, so this is not about the database refusing the value — it is
 * about an attacker choosing how many bytes each of their attempts costs us. A 64 KB User-Agent
 * repeated at attack rate is a disk-fill written by the thing that is supposed to be defending
 * against it.
 */
function bounded(value: string | undefined, limit: number): string | null {
	if (value === undefined || value === "") {
		return null;
	}
	return value.length > limit ? value.slice(0, limit) : value;
}
