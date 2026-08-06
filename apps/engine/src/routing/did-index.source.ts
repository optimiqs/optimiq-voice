import { Injectable } from "@nestjs/common";
import { isEntityId } from "@optimiq-voice/identifiers";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "../nats/jetstream.service";

/**
 * DID → organization, read from the `did-index` KV bucket.
 *
 * ## Why this exists
 *
 * An inbound INVITE from a carrier carries a dialled number and nothing that says whose it is. Every
 * decision after that point — which routing artifact to walk, which subject to publish on, which
 * tenant's CDR to write, which bucket the recording lands in — is organization-scoped. Until this
 * bucket existed the engine could only read `OPTIMIQ_ORG_ID` off the channel and reject the call
 * with `INVALID_PROFILE` when the dialplan had not been told, which is single-tenant by
 * construction. This is the lookup that makes multi-tenant inbound possible.
 *
 * ## No cache, on purpose
 *
 * Every other read on this path is cached: the routing artifact is held in memory behind a KV watch
 * because resolving a route is a hot loop and a stale artifact merely routes a call the way it was
 * routed a second ago. This one is different in the only way that matters — a stale entry attributes
 * a call to the WRONG TENANT, which is a billing error and an isolation breach at once, and both
 * are silent. The cost of getting it right is one KV round trip per unattributed inbound call, on a
 * path that is already about to do a KV read for the artifact and an HTTP round trip to answer the
 * channel. That is the correct trade, and it is written down here so that a future performance pass
 * has to argue against it rather than around it.
 *
 * ## What a miss means
 *
 * `undefined`, always — never a guess and never a default. The caller treats it as "this call has no
 * resolvable organization", which is a rejection. A DID that is genuinely provisioned and genuinely
 * missing from the bucket is a control-plane repair (`pnpm --filter @optimiq-voice/api
 * rebuild:did-index`), not something an engine may paper over by picking a tenant.
 */
@Injectable()
export class DidIndexSource {
	private readonly logger = getLogger("engine.did-index");
	private lookups = 0;
	private hits = 0;
	private misses = 0;

	constructor(private readonly jetstream: JetStreamService) {}

	get stats(): { readonly lookups: number; readonly hits: number; readonly misses: number } {
		return { lookups: this.lookups, hits: this.hits, misses: this.misses };
	}

	/**
	 * The organization that owns `did`, or `undefined`.
	 *
	 * Never throws: this runs inside `StasisStart`, and an exception there is an unhandled rejection
	 * in a WebSocket callback, which takes every other live call down with it. A broker that is
	 * unreachable reports a miss, and a miss is a rejected call — a rejected call the carrier can
	 * fail over is a better outcome than a call answered on behalf of a tenant nobody verified.
	 */
	async organizationFor(did: string | undefined): Promise<DidIndexHit | undefined> {
		const dialled = did?.trim();
		if (dialled === undefined || dialled === "") {
			return undefined;
		}
		const bucket = this.jetstream.didIndex;
		if (bucket === undefined) {
			return undefined;
		}

		let key: string;
		try {
			key = this.jetstream.didIndexKey(dialled);
		} catch {
			// A dialled string with no digits in it (an alphanumeric SIP user, an internal feature
			// code that reached the inbound context) is not a DID and has no key. Not an error.
			return undefined;
		}

		this.lookups += 1;
		try {
			const entry = await bucket.get(key);
			if (entry === null || entry.value.length === 0) {
				this.misses += 1;
				return undefined;
			}
			const hit = this.parse(entry.value, key);
			if (hit === undefined) {
				this.misses += 1;
				return undefined;
			}
			this.hits += 1;
			return hit;
		} catch (error) {
			this.misses += 1;
			this.logger.warn(
				{ did: dialled, err: String(error) },
				"could not read the did-index bucket; this call has no resolvable organization",
			);
			return undefined;
		}
	}

	/**
	 * Parses one entry.
	 *
	 * The organization id is validated as an entity id rather than trusted as a string. This value
	 * decides which tenant a call is filed under, and it arrives from another process through a
	 * bucket an operator can write by hand — "it was in the KV" is not, on its own, grounds to bill
	 * somebody.
	 */
	private parse(value: Uint8Array, key: string): DidIndexHit | undefined {
		let decoded: unknown;
		try {
			decoded = JSON.parse(new TextDecoder().decode(value));
		} catch (error) {
			this.logger.error({ key, err: String(error) }, "discarding an unreadable did-index entry");
			return undefined;
		}
		if (typeof decoded !== "object" || decoded === null) {
			return undefined;
		}
		const candidate = decoded as Record<string, unknown>;
		const organizationId = candidate.organizationId;
		if (typeof organizationId !== "string" || !isEntityId(organizationId)) {
			this.logger.error(
				{ key },
				"discarding a did-index entry whose organizationId is not an entity id",
			);
			return undefined;
		}
		return {
			organizationId,
			phoneNumberId:
				typeof candidate.phoneNumberId === "string" ? candidate.phoneNumberId : undefined,
			e164: typeof candidate.e164 === "string" ? candidate.e164 : undefined,
			// A disabled number still belongs to its tenant. Attributing the call and letting that
			// tenant's own routing reject it is what puts the rejection in the right CDR; treating it
			// as unallocated here would file it nowhere.
			enabled: candidate.enabled !== false,
		};
	}
}

/** What the index knows about one DID. */
export interface DidIndexHit {
	readonly organizationId: string;
	readonly phoneNumberId?: string;
	/** The E.164 as the control plane stores it, which may differ from the dialled form. */
	readonly e164?: string;
	readonly enabled: boolean;
}
