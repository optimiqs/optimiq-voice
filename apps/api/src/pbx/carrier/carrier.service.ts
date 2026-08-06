import { randomBytes } from "node:crypto";
import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { HttpStatus } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { createEntityId } from "@optimiq-voice/identifiers";
import { getLogger } from "@optimiq-voice/logging";
import {
	TELNYX_REGISTER_EXPIRES_SECONDS,
	TelnyxTransportError,
	telnyxSipDomain,
	telnyxSipProxy,
	telnyxSipUri,
	type TelnyxClient,
	type TelnyxNumberOrder,
} from "@optimiq-voice/telnyx";
import { PhoneNumbersService } from "../phone-numbers/phone-numbers.service";
import { TrunksService } from "../trunks/trunks.service";
import { CarrierNotConfiguredException, toCarrierException } from "./carrier.errors";
import { CARRIER_ENV, TELNYX_CLIENT } from "./carrier.tokens";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { WireDiagnostic } from "../shared/pbx.errors";
import type { CarrierEnv } from "./carrier-env";
import type { ProvisionTrunkBody, SearchAvailableNumbersQuery } from "./carrier.dto";
import type { AppSession } from "@optimiq-voice/auth";

const logger = getLogger("api.pbx");

/**
 * The carrier slice's domain logic: the part that knows what an organization is.
 *
 * ## The layering, and the one rule that keeps it honest
 *
 * `@optimiq-voice/telnyx` knows HTTP and nothing else. The PBX slice services own the database,
 * the tenant scope, the destination guards, compile-on-write and the DID index. This class is the
 * *only* place the two meet, and its rule is: **never write a PBX row directly**. Ordering a
 * number goes through `PhoneNumbersService.create`, so the global-uniqueness index, the
 * destination validation, the recompile and the `did-index` KV publish all happen exactly as they
 * do for a hand-created DID. A carrier-ordered number that skipped that path would be a number the
 * engine cannot route — which is the entire feature failing quietly.
 *
 * ## Two-phase operations without two-phase commit
 *
 * Buying a number is a distributed write across a system we do not control and a database we do,
 * and there is no transaction spanning both. Holding a Postgres transaction open across a carrier
 * round trip would be worse — it pins a connection for the duration of somebody else's outage —
 * so the sequence is: carrier first, database second, and **compensate** if the second half fails.
 *
 * That ordering is chosen because the failure it leaves is the recoverable one. Carrier-first
 * means a database failure leaves a number we own and did not record, which the compensating
 * release undoes and, if even that fails, a human can find from the log line below. Database-first
 * would mean a carrier failure leaves a row for a number we do not own — a DID the routing
 * compiler happily publishes to the DID index and the engine happily answers calls for, except
 * that no call will ever arrive. A visible orphan beats an invisible lie.
 *
 * The same reasoning runs backwards on delete: the local row goes first, so the reference guards
 * ("an inbound route still points here") still get to refuse, and the upstream release follows.
 */

/** What a carrier operation adds to the standard mutation envelope. */
export interface CarrierProvisionResult {
	readonly sipDomain: string;
	readonly sipProxy: string;
	readonly sipUsername: string;
	/**
	 * Returned once, at provisioning time, and never stored in `pbx-db`.
	 *
	 * It is not lost: Telnyx echoes the password on `GET /credential_connections/{id}`, and the
	 * trunk row keeps that id in `carrier_ref`, so the secret is always re-derivable from the
	 * carrier by anyone the platform trusts with the platform key. That is a strictly better place
	 * for it than a column in a database we hand to every service in the area.
	 */
	readonly sipPassword: string;
	readonly sipUri: string;
	readonly registerExpiresSeconds: number;
	readonly connectionId: string;
	readonly outboundVoiceProfileId: string;
	/** True when the trunk already had a connection and this call updated it in place. */
	readonly reprovisioned: boolean;
}

/**
 * Generates a Telnyx SIP username.
 *
 * The constraints are Telnyx's: 4-32 characters, alphanumeric only, and at least one letter among
 * the first five — a rule their docs state on the response schema and enforce on the request. The
 * fixed `ov` prefix satisfies the letter rule by construction rather than by luck, which matters
 * because a purely random alphanumeric string is all-digits in its first five characters about
 * once in every 130 tries, and a provisioning flow that fails 0.8% of the time is one nobody can
 * reproduce.
 *
 * 18 random characters over a 36-symbol alphabet is ~93 bits. The username is public — it is the
 * AoR — so this is not a secret; it is a collision guard against a namespace shared with every
 * other Telnyx customer.
 */
function generateSipUsername(): string {
	return `ov${randomAlphanumeric(18)}`;
}

/**
 * A SIP password.
 *
 * Alphanumeric only, despite Telnyx accepting any character in the 8-128 range. SIP digest
 * authentication carries the credential through headers whose escaping rules are implemented
 * inconsistently across user agents and proxies, and a password containing `:`, `"` or a
 * non-ASCII byte is the classic "registers from one softphone but not from Asterisk" bug. 32
 * alphanumerics is ~165 bits, which is far past the point where charset diversity buys anything.
 */
function generateSipPassword(): string {
	return randomAlphanumeric(32);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomAlphanumeric(length: number): string {
	// Rejection-free by construction: 62 does not divide 256, so a naive modulo would bias the
	// first 8 symbols. Drawing a wider integer per character and taking the modulo of a value with
	// >40 bits of entropy makes the bias smaller than any adversary could exploit, and avoids a
	// retry loop in a code path that must not be able to spin.
	const bytes = randomBytes(length * 6);
	let result = "";
	for (let index = 0; index < length; index += 1) {
		const slice = bytes.subarray(index * 6, index * 6 + 6);
		let value = 0;
		for (const byte of slice) {
			value = value * 256 + byte;
		}
		result += ALPHABET[value % ALPHABET.length];
	}
	return result;
}

/** The handle written into `trunk.sip_secret_ref`, following the area's existing `secret://` shape. */
export function telnyxSecretRef(trunkId: string): string {
	return `secret://telnyx/trunk/${trunkId}`;
}

@Injectable()
export class CarrierService {
	constructor(
		@Inject(CARRIER_ENV) private readonly env: CarrierEnv,
		@Inject(TELNYX_CLIENT) private readonly telnyx: TelnyxClient | undefined,
		@Inject(PhoneNumbersService) private readonly numbers: PhoneNumbersService,
		@Inject(TrunksService) private readonly trunks: TrunksService,
	) {}

	/** Whether this deployment can talk to a carrier at all. Drives the UI's "connect" callout. */
	get configured(): boolean {
		return this.telnyx !== undefined;
	}

	private client(capability: string): TelnyxClient {
		if (this.telnyx === undefined) {
			throw new CarrierNotConfiguredException(capability);
		}
		return this.telnyx;
	}

	status(): {
		readonly data: {
			readonly configured: boolean;
			readonly provider: "telnyx";
			readonly webhooksConfigured: boolean;
			readonly sipDomain: string;
		};
	} {
		return {
			data: {
				configured: this.configured,
				provider: "telnyx",
				webhooksConfigured: this.env.TELNYX_PUBLIC_KEY !== undefined,
				sipDomain: telnyxSipDomain(this.env.TELNYX_SIP_REGION),
			},
		};
	}

	// -----------------------------------------------------------------------------------------
	// Search
	// -----------------------------------------------------------------------------------------

	/**
	 * Searches the carrier's inventory.
	 *
	 * Not a passthrough: the response is reshaped into the platform's own vocabulary, because the
	 * browser must never learn the carrier's field names. The moment `apps/web` renders
	 * `cost_information.monthly_cost`, changing carrier becomes a frontend rewrite — and D5 is
	 * explicit that Telnyx is the first-class managed provider, not a hard dependency.
	 */
	async searchAvailableNumbers(
		session: AppSession,
		query: SearchAvailableNumbersQuery,
	): Promise<{
		readonly data: readonly {
			readonly e164: string;
			readonly region: string | null;
			readonly monthlyCost: string | null;
			readonly upfrontCost: string | null;
			readonly currency: string | null;
			readonly features: readonly string[];
			readonly reservable: boolean;
		}[];
		readonly total: number;
	}> {
		requireActiveOrganizationId(session);
		const client = this.client("Number search");
		try {
			const result = await client.availableNumbers.search({
				countryCode: query.country,
				phoneNumberType: query.numberType,
				limit: query.limit,
				...(query.areaCode === undefined ? {} : { nationalDestinationCode: query.areaCode }),
				...(query.contains === undefined ? {} : { contains: query.contains }),
				...(query.features === undefined ? {} : { features: query.features }),
			});
			return {
				data: result.data.map((entry) => ({
					e164: entry.phone_number,
					region:
						entry.region_information?.find((region) => region.region_type === "rate_center")
							?.region_name ??
						entry.region_information?.[0]?.region_name ??
						null,
					monthlyCost: entry.cost_information?.monthly_cost ?? null,
					upfrontCost: entry.cost_information?.upfront_cost ?? null,
					currency: entry.cost_information?.currency ?? null,
					features: (entry.features ?? []).map((feature) => feature.name),
					reservable: entry.reservable ?? true,
				})),
				total: result.totalResults ?? result.data.length,
			};
		} catch (error) {
			logger.warn({ error }, "carrier number search failed");
			throw toCarrierException(error, "the number search");
		}
	}

	// -----------------------------------------------------------------------------------------
	// Order
	// -----------------------------------------------------------------------------------------

	/**
	 * Buys a DID and records it, in that order. See the class header for why that order.
	 */
	async orderNumber(
		session: AppSession,
		body: {
			readonly e164: string;
			readonly trunkId?: string;
			readonly [key: string]: unknown;
		},
	): Promise<MutationEnvelope<Record<string, unknown>> & { readonly carrier: unknown }> {
		const organizationId = requireActiveOrganizationId(session);
		const client = this.client("Number ordering");

		const { trunkId, ...numberValues } = body;
		const connectionId =
			trunkId === undefined ? undefined : await this.telnyxConnectionOf(session, trunkId);

		/**
		 * Our own idempotency token, because Telnyx offers none on this endpoint.
		 *
		 * A UUID v7 generated here and stamped on the order is what makes a timed-out request
		 * recoverable: the reconciliation read below asks "is there already an order carrying this
		 * token?", which is a question with a definite answer — unlike "did my POST land?", which
		 * is not.
		 */
		const customerReference = `optimiq-${organizationId}-${createEntityId()}`;

		let order: TelnyxNumberOrder;
		try {
			order = await client.numberOrders.create({
				phoneNumbers: [body.e164],
				customerReference,
				...(connectionId === undefined ? {} : { connectionId }),
			});
		} catch (error) {
			if (error instanceof TelnyxTransportError) {
				// The one case where "did it happen?" is genuinely unknown. Reconcile rather than
				// retry: retrying is how one order becomes two, and two DIDs are two monthly bills.
				const reconciled = await this.reconcileOrder(client, customerReference);
				if (reconciled === undefined) {
					logger.error(
						{
							organizationId,
							customerReference,
							error,
						},
						"carrier order outcome unknown",
					);
					throw toCarrierException(error, "the number order");
				}
				logger.warn(
					{
						organizationId,
						customerReference,
						orderId: reconciled.id,
					},
					"carrier order reconciled after a transport failure",
				);
				order = reconciled;
			} else {
				logger.warn({ organizationId, error }, "carrier order refused");
				throw toCarrierException(error, "the number order");
			}
		}

		if (order.status === "failure") {
			throw new UnprocessableEntityException({
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "CARRIER_REJECTED",
				message: `The carrier could not complete the order for ${body.e164}. Choose a different number.`,
				carrierOrderId: order.id,
			});
		}

		const carrierNumberId = await this.resolveCarrierNumberId(client, order, body.e164);

		try {
			const created = await this.numbers.create(session, {
				...numberValues,
				carrierProvider: "telnyx",
				carrierRef: carrierNumberId,
			});
			logger.info(
				{
					organizationId,
					e164: body.e164,
					carrierRef: carrierNumberId,
					orderId: order.id,
				},
				"carrier number ordered",
			);
			return {
				...created,
				carrier: {
					provider: "telnyx",
					orderId: order.id,
					orderStatus: order.status,
					carrierRef: carrierNumberId,
				},
			};
		} catch (error) {
			// The compensating release. The number is ours and unrecorded; leaving it that way is a
			// recurring charge for a DID nobody can see. If the release itself fails there is nothing
			// more this process can do, so the log line carries every identifier a human needs.
			await this.compensateRelease(client, carrierNumberId, body.e164, organizationId);
			throw error;
		}
	}

	/** The reconciliation read that stands in for the idempotency the carrier does not offer. */
	private async reconcileOrder(
		client: TelnyxClient,
		customerReference: string,
	): Promise<TelnyxNumberOrder | undefined> {
		try {
			const orders = await client.numberOrders.findByCustomerReference(customerReference);
			return orders[0];
		} catch (error) {
			logger.error({ customerReference, error }, "carrier order reconciliation failed");
			return undefined;
		}
	}

	/**
	 * The carrier's id for the number we just bought.
	 *
	 * Taken from the order when it carries one, and looked up otherwise. The lookup exists because
	 * an order that is still `pending` may not have per-number ids yet, and the id is not optional
	 * for us: without it, `carrier_ref` is empty and the release path has nothing to release.
	 */
	private async resolveCarrierNumberId(
		client: TelnyxClient,
		order: TelnyxNumberOrder,
		e164: string,
	): Promise<string> {
		const fromOrder = order.phone_numbers.find((entry) => entry.phone_number === e164)?.id;
		if (typeof fromOrder === "string" && fromOrder.length > 0) {
			return fromOrder;
		}
		const owned = await client.phoneNumbers.list({ phoneNumber: e164 });
		const match = owned.find((entry) => entry.phone_number === e164);
		if (match === undefined) {
			throw new UnprocessableEntityException({
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "CARRIER_REJECTED",
				message: `The carrier accepted the order for ${e164} but has not provisioned it yet. It will appear once the order completes; do not order it again.`,
				carrierOrderId: order.id,
			});
		}
		return match.id;
	}

	private async compensateRelease(
		client: TelnyxClient,
		carrierRef: string,
		e164: string,
		organizationId: string,
	): Promise<void> {
		try {
			await client.phoneNumbers.release(carrierRef);
			logger.warn(
				{
					organizationId,
					e164,
					carrierRef,
				},
				"carrier number released after a failed local write",
			);
		} catch (error) {
			logger.error(
				{ organizationId, e164, carrierRef, error },
				"ORPHANED CARRIER NUMBER — bought but neither recorded nor released; release it by hand",
			);
		}
	}

	// -----------------------------------------------------------------------------------------
	// Release
	// -----------------------------------------------------------------------------------------

	/**
	 * Deletes a DID and, when the platform bought it, releases it upstream.
	 *
	 * Local first. The reference guards in the repository — "an inbound route still points at this
	 * number" — are the reason: releasing before them would give up a number the organization is
	 * still configured to use, and the 409 that follows would leave the admin looking at a DID that
	 * no longer exists at the carrier.
	 *
	 * A failed upstream release does NOT fail the request. The local delete has committed, the
	 * tenant's view is correct, and turning that into a 502 would leave the admin unable to
	 * complete an operation that already succeeded. It surfaces as a warning in the envelope — the
	 * same channel the compiler's warnings use — and as an error-level log line for the operator
	 * who has to reconcile the bill.
	 */
	async releaseNumber(
		session: AppSession,
		phoneNumberId: string,
	): Promise<MutationEnvelope<{ readonly id: string }>> {
		const organizationId = requireActiveOrganizationId(session);
		const existing = await this.numbers.get(session, phoneNumberId);
		const row = existing.data;
		const carrierProvider = typeof row.carrierProvider === "string" ? row.carrierProvider : null;
		const carrierRef = typeof row.carrierRef === "string" ? row.carrierRef : null;

		const removed = await this.numbers.remove(session, phoneNumberId);

		if (carrierProvider !== "telnyx" || carrierRef === null) {
			// A hand-entered DID or a BYO number. Nothing upstream to do, and saying nothing to the
			// carrier is exactly right — this is the carrier-agnostic half of D5.
			return removed;
		}

		if (this.telnyx === undefined) {
			const warning: WireDiagnostic = {
				severity: "warning",
				code: "carrier-release-skipped",
				message: `${row.e164 as string} was removed here, but this deployment has no carrier configured, so it was not released at Telnyx. It is still being billed.`,
			};
			logger.error(
				{
					organizationId,
					carrierRef,
				},
				"carrier-managed number deleted with no carrier configured",
			);
			return { ...removed, warnings: [...removed.warnings, warning] };
		}

		try {
			await this.telnyx.phoneNumbers.release(carrierRef);
			logger.info(
				{
					organizationId,
					e164: row.e164,
					carrierRef,
				},
				"carrier number released",
			);
			return removed;
		} catch (error) {
			logger.error(
				{ organizationId, e164: row.e164, carrierRef, error },
				"ORPHANED CARRIER NUMBER — deleted here but not released upstream; release it by hand",
			);
			const warning: WireDiagnostic = {
				severity: "warning",
				code: "carrier-release-failed",
				message: `${row.e164 as string} was removed here, but the carrier did not confirm the release. It may still be billed; an operator has been notified.`,
			};
			return { ...removed, warnings: [...removed.warnings, warning] };
		}
	}

	// -----------------------------------------------------------------------------------------
	// Trunk provisioning
	// -----------------------------------------------------------------------------------------

	/**
	 * Turns an empty trunk row into a working Telnyx SIP trunk.
	 *
	 * Two carrier resources are created, in this order and for this reason: the outbound voice
	 * profile carries the spend limit and the destination allow-list, so it must exist *before* a
	 * connection can be bound to it. A connection created first would be, for however long it takes
	 * to create the profile, a credential that can dial anywhere with no daily cap — which is the
	 * exact window an attacker who obtained it would need.
	 *
	 * Re-provisioning an already-provisioned trunk updates in place rather than creating a second
	 * connection. Not a convenience: an admin who clicks the button twice would otherwise leave a
	 * live credential nobody has a record of, since the trunk row can only remember one
	 * `carrier_ref`.
	 */
	async provisionTrunk(
		session: AppSession,
		trunkId: string,
		body: ProvisionTrunkBody,
	): Promise<
		MutationEnvelope<Record<string, unknown>> & { readonly carrier: CarrierProvisionResult }
	> {
		const organizationId = requireActiveOrganizationId(session);
		const client = this.client("Trunk provisioning");
		const trunk = (await this.trunks.get(session, trunkId)).data;

		const existingConnectionId =
			trunk.carrierProvider === "telnyx" && typeof trunk.carrierRef === "string"
				? trunk.carrierRef
				: undefined;
		const existingProfileId =
			typeof trunk.carrierProfileRef === "string" ? trunk.carrierProfileRef : undefined;

		const region = this.env.TELNYX_SIP_REGION;
		const profileName = `optimiq ${String(trunk.name)} (${organizationId.slice(0, 8)})`;

		try {
			const profile =
				existingProfileId === undefined
					? await client.outboundVoiceProfiles.create({
							name: profileName,
							enabled: true,
							whitelistedDestinations: (body.whitelistedDestinations ??
								this.env.TELNYX_WHITELISTED_DESTINATIONS) as readonly string[],
							dailySpendLimit: body.dailySpendLimit ?? this.env.TELNYX_DAILY_SPEND_LIMIT,
							dailySpendLimitEnabled: true,
							...(body.concurrentCallLimit === undefined
								? {}
								: { concurrentCallLimit: body.concurrentCallLimit }),
						})
					: await client.outboundVoiceProfiles.update(existingProfileId, {
							whitelistedDestinations: (body.whitelistedDestinations ??
								this.env.TELNYX_WHITELISTED_DESTINATIONS) as readonly string[],
							dailySpendLimit: body.dailySpendLimit ?? this.env.TELNYX_DAILY_SPEND_LIMIT,
							dailySpendLimitEnabled: true,
							...(body.concurrentCallLimit === undefined
								? {}
								: { concurrentCallLimit: body.concurrentCallLimit }),
						});

			// A fresh password on every provision, including a re-provision. The alternative — reusing
			// the existing secret — would make "rotate this trunk's credential" impossible without
			// deleting the trunk, and a credential that can never be rotated is one that is
			// permanently compromised the first time it leaks.
			const password = generateSipPassword();
			const connection =
				existingConnectionId === undefined
					? await client.credentialConnections.create({
							connectionName: profileName,
							userName: generateSipUsername(),
							password,
							outboundVoiceProfileId: profile.id,
							anchorsiteOverride: "Latency",
							dtmfType: "RFC 2833",
							active: true,
							...(body.concurrentCallLimit === undefined
								? {}
								: { outboundChannelLimit: body.concurrentCallLimit }),
							...(this.env.TELNYX_WEBHOOK_URL === undefined
								? {}
								: { webhookEventUrl: this.env.TELNYX_WEBHOOK_URL }),
						})
					: await client.credentialConnections.update(existingConnectionId, {
							password,
							outboundVoiceProfileId: profile.id,
							...(this.env.TELNYX_WEBHOOK_URL === undefined
								? {}
								: { webhookEventUrl: this.env.TELNYX_WEBHOOK_URL }),
						});

			const updated = await this.trunks.update(session, trunkId, {
				kind: "register",
				sipDomain: telnyxSipDomain(region),
				sipProxy: telnyxSipProxy(region),
				authUser: connection.user_name,
				// The handle, not the secret. See `CarrierProvisionResult.sipPassword`.
				sipSecretRef: telnyxSecretRef(trunkId),
				registerExpiresSeconds: TELNYX_REGISTER_EXPIRES_SECONDS,
				transport: "udp",
				carrierProvider: "telnyx",
				carrierRef: connection.id,
				carrierProfileRef: profile.id,
			});

			logger.info(
				{
					organizationId,
					trunkId,
					connectionId: connection.id,
					outboundVoiceProfileId: profile.id,
					reprovisioned: existingConnectionId !== undefined,
				},
				"trunk provisioned with telnyx",
			);

			return {
				...updated,
				carrier: {
					sipDomain: telnyxSipDomain(region),
					sipProxy: telnyxSipProxy(region),
					sipUsername: connection.user_name,
					sipPassword: connection.password,
					sipUri: telnyxSipUri(connection.user_name, region),
					registerExpiresSeconds: TELNYX_REGISTER_EXPIRES_SECONDS,
					connectionId: connection.id,
					outboundVoiceProfileId: profile.id,
					reprovisioned: existingConnectionId !== undefined,
				},
			};
		} catch (error) {
			logger.warn({ organizationId, trunkId, error }, "trunk provisioning failed");
			throw toCarrierException(error, "trunk provisioning");
		}
	}

	/**
	 * The Telnyx connection id behind a trunk, refusing a trunk that has none.
	 *
	 * Refusing rather than ignoring: pointing a Telnyx DID at a BYO-SIP trunk produces a
	 * configuration that looks correct in the admin UI and silently drops every inbound call,
	 * because Telnyx has nowhere to send them. A 422 naming the problem costs one round trip; the
	 * alternative costs a support ticket that starts "our new number doesn't ring".
	 */
	private async telnyxConnectionOf(session: AppSession, trunkId: string): Promise<string> {
		const trunk = (await this.trunks.get(session, trunkId)).data;
		if (trunk.carrierProvider !== "telnyx" || typeof trunk.carrierRef !== "string") {
			throw new UnprocessableEntityException({
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "CARRIER_TRUNK_NOT_PROVISIONED",
				message: `Trunk "${String(trunk.name)}" is not provisioned with Telnyx, so a Telnyx number cannot be pointed at it. Provision the trunk first, or order the number without one.`,
				field: "trunkId",
			});
		}
		return trunk.carrierRef;
	}
}
