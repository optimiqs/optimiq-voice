import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { CarrierNotConfiguredException, toCarrierException } from "../carrier/carrier.errors";
import { TELNYX_CLIENT } from "../carrier/carrier.tokens";
import { PbxResourceService } from "../shared/pbx-resource.service";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import {
	EMERGENCY_VALIDATION_PROVIDER,
	validateAddressWithCarrier,
} from "./emergency-address-validation";
import { EmergencyAddressNotValidatedException } from "./emergency-addresses.errors";
import { EMERGENCY_ADDRESS_RESOURCE } from "./emergency-addresses.resource";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type {
	CarrierValidationOutcome,
	EmergencyAddressFields,
} from "./emergency-address-validation";
import type { AppSession } from "@optimiq-voice/auth";
import type { TelnyxClient } from "@optimiq-voice/telnyx";

const logger = getLogger("api.pbx");

/**
 * The `validated` quartet, as it goes onto the row.
 *
 * Written here and by nothing else. `emergency-addresses.dto.ts` states the rule from the other
 * side — these four are facts a PROVIDER asserted, never values a request body may carry — and this
 * is the one code path allowed to assert them. Anything that could let a tenant reach these column
 * names from a payload is a compliance bug, not a validation one.
 */
function validationColumns(outcome: CarrierValidationOutcome): Record<string, unknown> {
	return {
		validated: outcome.validated,
		validatedAt: outcome.validated ? new Date() : null,
		validationProvider: outcome.validated ? EMERGENCY_VALIDATION_PROVIDER : null,
		validationReference: outcome.reference,
	};
}

/** What `POST …/:id/validate` answers with: the row as it now stands, and what the carrier said. */
export interface EmergencyAddressValidationEnvelope {
	readonly data: Record<string, unknown>;
	readonly validation: {
		readonly validated: boolean;
		readonly result: string;
		readonly reason: string | null;
		readonly suggestion: Record<string, unknown> | null;
		readonly provider: string;
	};
}

/**
 * Dispatchable locations, plus the carrier validation that makes `validated` mean something.
 *
 * ## Why validation lives on the CRUD service rather than beside the carrier slice
 *
 * `CarrierService` owns the operations whose subject is a carrier object — a number order, a port,
 * a CNAM listing. An address is not one of those: its subject is a row in this tenant's database
 * that happens to need a third party's opinion before one column may be set. Putting the call here
 * keeps the row read, the row write and the audit actor in one place, and means there is no path
 * that can write `validated` without having just asked.
 *
 * ## Degradation, copied from the carrier slice rather than reinvented
 *
 * `TELNYX_CLIENT` is `TelnyxClient | undefined` — a deployment with no `TELNYX_API_KEY` has no
 * carrier (`carrier/carrier.providers.ts`). The explicit `POST …/:id/validate` route answers
 * `503 CARRIER_NOT_CONFIGURED` in that case, which is the same answer every other carrier-backed
 * endpoint gives. Create and update do NOT: they are ordinary CRUD that a deployment without a
 * carrier must keep being able to perform, so validation is attempted only when there is somebody
 * to ask, and the row is simply left unvalidated otherwise. The gate below then does its job — an
 * unvalidated address cannot be attached — which is the honest end state for a deployment that has
 * not connected a carrier.
 */
@Injectable()
export class EmergencyAddressesService extends PbxResourceService {
	constructor(
		@Inject(PBX_EFFECT_RUNTIME) runtime: PbxRepositoryRuntime,
		@Inject(TELNYX_CLIENT) private readonly telnyx: TelnyxClient | undefined,
	) {
		super(runtime, EMERGENCY_ADDRESS_RESOURCE);
	}

	/** Whether this deployment can validate at all. Drives the UI's "connect a carrier" callout. */
	get carrierConfigured(): boolean {
		return this.telnyx !== undefined;
	}

	/**
	 * Creates the address, then asks the carrier about it in the same request.
	 *
	 * One request rather than "create, then remember to validate" because the second step is the one
	 * that gets forgotten, and a forgotten validation is an address that looks finished in the list
	 * and cannot be attached to anything. The write is NOT rolled back when the carrier refuses: the
	 * address the admin typed is worth keeping so it can be corrected, and it is inert until
	 * validated.
	 */
	override async create(
		session: AppSession,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const created = await super.create(session, values);
		const row = await this.revalidate(session, created.data);
		return { ...created, data: row };
	}

	/**
	 * Edits the address and re-asks.
	 *
	 * This is the honest version of the risk `emergency-addresses.controller.ts` records: an edit
	 * used to leave `validated: true` on an address the carrier had never seen. Now the edit carries
	 * its own re-validation, so a substantive change to a validated address either stays validated
	 * or stops being validated — and in the second case the numbers that already point at it keep
	 * their assignment (this platform does not silently strip a live location) while any NEW
	 * assignment is refused until it is fixed.
	 */
	override async update(
		session: AppSession,
		id: string,
		values: Record<string, unknown>,
	): Promise<MutationEnvelope<Record<string, unknown>>> {
		const updated = await super.update(session, id, values);
		const row = await this.revalidate(session, updated.data);
		return { ...updated, data: row };
	}

	/**
	 * `POST /api/v1/emergency-addresses/:id/validate` — ask the carrier, on demand.
	 *
	 * Answers `200` whatever the carrier said, including "no". A refusal is not an error in this
	 * request: the caller asked a question and got the authoritative answer, and the answer includes
	 * the carrier's reason and, when there is one, the corrected address it suggests. Turning that
	 * into a 4xx would leave the reason in an error body the admin UI has to reverse-engineer, and
	 * would make "is this address real?" indistinguishable from "your request was wrong".
	 */
	async validateWithCarrier(
		session: AppSession,
		id: string,
	): Promise<EmergencyAddressValidationEnvelope> {
		const telnyx = this.telnyx;
		if (telnyx === undefined) {
			throw new CarrierNotConfiguredException("Emergency address validation");
		}
		const organizationId = this.organizationId(session);
		const { data: row } = await this.get(session, id);
		let outcome: CarrierValidationOutcome;
		try {
			outcome = await validateAddressWithCarrier(telnyx, asFields(row), organizationId);
		} catch (error) {
			throw toCarrierException(error, "validating an emergency address");
		}
		const { data } = await super.update(session, id, validationColumns(outcome));
		return {
			data,
			validation: {
				validated: outcome.validated,
				result: outcome.result,
				reason: outcome.reason,
				suggestion: outcome.suggestion,
				provider: EMERGENCY_VALIDATION_PROVIDER,
			},
		};
	}

	/**
	 * Refuses unless `addressId` names an address in this tenant that the carrier has validated.
	 *
	 * **This is the gate the schema comment promises**, and it lives here — one function, one
	 * meaning — rather than being re-implemented at each seam that can attach an address. Every
	 * write that sets an emergency-address reference must call it before persisting:
	 *
	 * - `phone_number.emergency_address_id` (`pbx/phone-numbers/phone-numbers.service.ts`)
	 * - `device.emergency_address_id` (`provisioning/devices/devices.service.ts`)
	 *
	 * A null or absent id is allowed through: clearing an emergency address is a different decision
	 * with a different guard (`assertMayWriteDispatchableLocation`), and refusing it here would make
	 * a bad address unremovable.
	 */
	async assertAssignable(
		session: AppSession,
		addressId: string | null | undefined,
		subject = "this record",
	): Promise<void> {
		if (addressId === null || addressId === undefined || addressId.length === 0) {
			return;
		}
		const { data: row } = await this.get(session, addressId);
		if (row.validated !== true) {
			throw new EmergencyAddressNotValidatedException(addressId, subject);
		}
	}

	/**
	 * Validates `row` if there is a carrier to ask, and returns the row as it now stands.
	 *
	 * A carrier that is unreachable does not fail the CRUD write that triggered this — the address
	 * is saved, unvalidated, and the explicit route exists to retry. Failing the create would mean a
	 * carrier outage stops an admin from recording the location of a new office, and would leave
	 * them nothing to retry with.
	 */
	private async revalidate(
		session: AppSession,
		row: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const telnyx = this.telnyx;
		const id = typeof row.id === "string" ? row.id : undefined;
		if (telnyx === undefined || id === undefined) {
			return row;
		}
		try {
			const outcome = await validateAddressWithCarrier(
				telnyx,
				asFields(row),
				this.organizationId(session),
			);
			const { data } = await super.update(session, id, validationColumns(outcome));
			return data;
		} catch (error) {
			logger.warn(
				{ addressId: id, err: error },
				"emergency address saved but not validated: the carrier could not be asked",
			);
			return row;
		}
	}
}

/** The postal fields, read off a row the repository returned. */
function asFields(row: Record<string, unknown>): EmergencyAddressFields {
	const text = (key: string): string => (typeof row[key] === "string" ? (row[key] as string) : "");
	const optional = (key: string): string | null =>
		typeof row[key] === "string" ? (row[key] as string) : null;
	return {
		streetLine1: text("streetLine1"),
		streetLine2: optional("streetLine2"),
		locationDetail: optional("locationDetail"),
		locality: text("locality"),
		administrativeArea: text("administrativeArea"),
		postalCode: text("postalCode"),
		country: optional("country"),
	};
}
