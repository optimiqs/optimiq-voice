import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { TELNYX_CLIENT } from "../pbx/carrier/carrier.tokens";
import { normalizePagination, paged } from "../pbx/shared/pagination";
import { PBX_DATABASE } from "../pbx/shared/pbx.tokens";
import {
	MessagingNotConfiguredException,
	MessagingNotFoundException,
	MessagingRegistrationStateException,
} from "./messaging.errors";
import {
	getBrand,
	getBrandEin,
	getCampaign,
	getMessagingNumber,
	insertBrand,
	insertCampaign,
	insertTollFreeVerification,
	listBrands,
	listCampaigns,
	listTollFreeVerifications,
	updateBrand,
	updateCampaign,
	updateMessagingNumber,
	updateTollFreeVerification,
} from "./messaging.repository";
import { MESSAGING_ENV } from "./messaging.tokens";
import type { ListQuery } from "../pbx/shared/pagination";
import type { MessagingEnv } from "./messaging-env";
import type {
	AssignCampaignNumberDto,
	CreateBrandDto,
	CreateCampaignDto,
	SubmitTollFreeVerificationDto,
	UpdateCampaignDto,
	VerifyBrandOtpDto,
} from "./messaging.dto";
import type {
	BrandRow,
	CampaignRow,
	MessagingNumberRow,
	TollFreeVerificationRow,
} from "./messaging.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type {
	MessagingBrandStatus,
	MessagingCampaignStatus,
	TollFreeVerificationStatus,
} from "@optimiq-voice/pbx-db";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";
import type { TelnyxClient } from "@optimiq-voice/telnyx";

const logger = getLogger("api.messaging");

/**
 * A2P registration: 10DLC brands and campaigns, and toll-free verification.
 *
 * Split out of {@link MessagingService} rather than bolted onto it because the two answer different
 * questions on different clocks. `MessagingService` owns the SEND path, which is synchronous and
 * refuses in milliseconds; this owns the REGISTRATION path, which is a days-long conversation with
 * two registries whose outcome arrives long after the request that started it. Sharing a class
 * would mean sharing a mental model that does not fit either.
 *
 * # Row before carrier, everywhere
 *
 * Every submission here writes the local row FIRST, calls the carrier second, and writes the
 * carrier's id and status back third. The failure mode that ordering is chosen against is the
 * asymmetric one: a carrier call that succeeds against a row that was never written leaves a billed,
 * unreferenced registration at TCR that nobody in this platform can see, retry, or delete. The
 * reverse — a row whose carrier call failed — is visible, retryable, and costs nothing. Neither
 * `createBrand` nor `createCampaign` is retryable at the carrier (no idempotency key, a registry fee
 * per attempt; see `ten-dlc.ts`), which is exactly why the invisible half must be the cheap one.
 *
 * # The status maps are exported functions, not inline switches
 *
 * `mapBrandStatus`, `mapCampaignStatus` and `mapTollFreeStatus` are pure and exported because the
 * create path and the poller BOTH translate the same carrier vocabulary. Two copies would drift, and
 * a drift here reads as a registration that flips status every poll.
 *
 * # Reads work without a carrier, writes do not
 *
 * Every submitting method refuses with `MessagingNotConfiguredException` when no carrier is wired.
 * The list/get reads deliberately do not: an admin must be able to see WHY a number cannot send
 * while the carrier key is missing or the carrier is down, and a 503 on the page that explains the
 * outage is the least helpful possible answer.
 */
@Injectable()
export class MessagingRegistrationService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(MESSAGING_ENV) private readonly env: MessagingEnv,
		@Inject(TELNYX_CLIENT) private readonly carrier: TelnyxClient | undefined,
	) {}

	// ---- brands ------------------------------------------------------------------------------

	async listBrands(session: AppSession, query: ListQuery) {
		const organizationId = requireActiveOrganizationId(session);
		const pagination = normalizePagination(query);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const { rows, total } = await listBrands(transaction, pagination);
			return paged(rows, total, pagination);
		});
	}

	async getBrand(session: AppSession, id: string): Promise<BrandRow> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getBrand(transaction, id),
		);
		if (row === undefined) {
			throw new MessagingNotFoundException("brand");
		}
		return row;
	}

	/**
	 * Registers a brand with TCR.
	 *
	 * The EIN is written to the row and then read back out of it with {@link getBrandEin} for the
	 * submission, rather than being carried in a local variable across the carrier call. That looks
	 * redundant and is not: it makes the row the single place the identifier lives, so the
	 * resubmission path after a rejection reads it the same way this one does and no second code path
	 * has to be trusted to keep it out of a log line.
	 */
	async createBrand(session: AppSession, dto: CreateBrandDto): Promise<BrandRow> {
		const organizationId = requireActiveOrganizationId(session);
		const carrier = this.requireCarrier();

		// Step one: the row. See the class header — an unwritten row against a succeeded registry
		// submission is a brand nobody can see and nobody can retry.
		const created = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await insertBrand(transaction, {
					organizationId,
					displayName: dto.displayName,
					companyName: dto.companyName,
					entityType: dto.entityType,
					ein: dto.ein ?? null,
					vertical: dto.vertical ?? null,
					email: dto.email,
					phone: dto.phone ?? null,
					website: dto.website ?? null,
					street: dto.street ?? null,
					city: dto.city ?? null,
					state: dto.state ?? null,
					postalCode: dto.postalCode ?? null,
					country: dto.country,
					status: "pending" satisfies MessagingBrandStatus,
					statusReason: "Submitted to The Campaign Registry; vetting is in progress.",
				}),
		);

		const ein = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getBrandEin(transaction, created.id),
		);

		const submitted = await carrier.tenDlc.createBrand({
			entityType: dto.entityType,
			displayName: dto.displayName,
			companyName: dto.companyName,
			country: dto.country,
			email: dto.email,
			// TCR requires a vertical on every brand and rejects the submission without one. `OTHER`
			// is the registry's own catch-all, so an admin who did not pick one gets a submission
			// rather than a form error about a taxonomy they have never heard of.
			vertical: dto.vertical ?? "OTHER",
			...(ein === null || ein === undefined ? {} : { ein }),
			...(dto.phone === undefined ? {} : { phone: dto.phone }),
			...(dto.street === undefined ? {} : { street: dto.street }),
			...(dto.city === undefined ? {} : { city: dto.city }),
			...(dto.state === undefined ? {} : { state: dto.state }),
			...(dto.postalCode === undefined ? {} : { postalCode: dto.postalCode }),
			...(dto.website === undefined ? {} : { website: dto.website }),
			...(this.env.MESSAGING_DRIVER === "telnyx" ? {} : { mock: true }),
		});

		const status = mapBrandStatus(submitted.identityStatus);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await updateBrand(transaction, created.id, {
					carrierBrandId: submitted.brandId,
					status,
					statusReason: submitted.failureReasons ?? brandStatusReason(status),
					lastPolledAt: new Date(),
				}),
		);
		// The id is logged; the EIN never is, and is not in scope here to be logged by accident.
		logger.info(
			{ organizationId, brandId: created.id, carrierBrandId: submitted.brandId, status },
			"a 10DLC brand was submitted to the registry",
		);
		return row ?? created;
	}

	/**
	 * Sends the sole-proprietor SMS PIN.
	 *
	 * Refused for every other entity type rather than passed through to the carrier: a
	 * `PRIVATE_PROFIT` brand vets against its EIN and has no OTP challenge, so the carrier's answer
	 * would be a bare 422 about a flow the admin never chose. Naming the entity type is the useful
	 * half of the refusal.
	 */
	async triggerBrandOtp(session: AppSession, id: string): Promise<BrandRow> {
		const organizationId = requireActiveOrganizationId(session);
		const carrier = this.requireCarrier();
		const brand = await this.getBrand(session, id);
		const carrierBrandId = requireSoleProprietorOtp(brand);

		const updated = await carrier.tenDlc.triggerBrandOtp(carrierBrandId);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await updateBrand(transaction, brand.id, {
					// The reference is the carrier's brand id: the challenge is keyed by brand, not by
					// a separate challenge id, so there is nothing else to store and a null here would
					// read as "no PIN outstanding" while one is in somebody's inbox.
					otpReference: carrierBrandId,
					status: mapBrandStatus(updated.identityStatus),
					statusReason: "A verification PIN was sent to the brand's mobile number.",
				}),
		);
		return row ?? brand;
	}

	/** Submits the PIN back. Clears `otpReference` on success — the challenge is spent either way. */
	async verifyBrandOtp(session: AppSession, id: string, dto: VerifyBrandOtpDto): Promise<BrandRow> {
		const organizationId = requireActiveOrganizationId(session);
		const carrier = this.requireCarrier();
		const brand = await this.getBrand(session, id);
		const carrierBrandId = requireSoleProprietorOtp(brand);

		const verified = await carrier.tenDlc.verifyBrandOtp(carrierBrandId, dto.pin);
		const status = mapBrandStatus(verified.identityStatus);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await updateBrand(transaction, brand.id, {
					otpReference: null,
					status,
					statusReason: verified.failureReasons ?? brandStatusReason(status),
					lastPolledAt: new Date(),
				}),
		);
		return row ?? brand;
	}

	// ---- campaigns ---------------------------------------------------------------------------

	async listCampaigns(session: AppSession, query: ListQuery) {
		const organizationId = requireActiveOrganizationId(session);
		const pagination = normalizePagination(query);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const { rows, total } = await listCampaigns(transaction, pagination);
			return paged(rows, total, pagination);
		});
	}

	async getCampaign(session: AppSession, id: string): Promise<CampaignRow> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getCampaign(transaction, id),
		);
		if (row === undefined) {
			throw new MessagingNotFoundException("campaign");
		}
		return row;
	}

	/**
	 * Registers a campaign under a vetted brand.
	 *
	 * The brand-status gate is local and deliberate. TCR refuses a campaign whose brand has not been
	 * vetted, and it refuses it by BILLING the attempt and returning a message about the brand rather
	 * than the campaign. Checking the stored status first turns a paid-for rejection days later into
	 * a sentence that names what the brand is currently waiting on.
	 */
	async createCampaign(session: AppSession, dto: CreateCampaignDto): Promise<CampaignRow> {
		const organizationId = requireActiveOrganizationId(session);
		const carrier = this.requireCarrier();

		const brand = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getBrand(transaction, dto.brandId),
		);
		if (brand === undefined) {
			throw new MessagingNotFoundException("brand");
		}
		/**
		 * The registry accepts a campaign from a brand that has an IDENTITY, not only from one that
		 * has been fully vetted — and the difference matters commercially, so the gate is drawn where
		 * TCR draws it rather than one notch tighter.
		 *
		 * `SELF_DECLARED` is where an EIN-backed brand lands the moment it is filed, and it can run
		 * campaigns immediately at a low throughput class; paid vetting is what buys `VETTED_VERIFIED`
		 * and a higher one. Refusing a self-declared brand here would mean every new tenant is told to
		 * wait for something that may never happen, for a campaign the registry would have accepted.
		 *
		 * What is refused is a brand with no identity at all: `pending` (nothing filed yet),
		 * `unverified` (a sole proprietor who has not completed the SMS OTP) and `failed`. Those are
		 * the states where the registry itself rejects the campaign, so filing one only spends a
		 * submission and returns a 422 an admin cannot act on.
		 */
		const BRAND_MAY_FILE_CAMPAIGNS = new Set(["self-declared", "verified", "vetted-verified"]);
		if (!BRAND_MAY_FILE_CAMPAIGNS.has(brand.status ?? "")) {
			throw new MessagingRegistrationStateException(
				`Brand "${brand.displayName}" is ${brand.status}; the registry accepts a campaign only ` +
					"once the brand has a confirmed identity. " +
					(brand.status === "unverified"
						? "Complete the SMS verification on the brand first."
						: "Wait for the brand's registration to settle, or resubmit it."),
			);
		}
		if (brand.carrierBrandId === null) {
			throw new MessagingRegistrationStateException(
				`Brand "${brand.displayName}" has no registry id yet, so no campaign can be filed ` +
					"under it. Resubmit the brand first.",
			);
		}

		const created = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await insertCampaign(transaction, {
					organizationId,
					brandId: brand.id,
					name: dto.name,
					useCase: dto.useCase,
					description: dto.description,
					sampleMessages: [...dto.sampleMessages],
					messageFlow: dto.messageFlow,
					helpMessage: dto.helpMessage,
					...(dto.optOutMessage === undefined ? {} : { optOutMessage: dto.optOutMessage }),
					...(dto.optInKeywords === undefined ? {} : { optInKeywords: dto.optInKeywords }),
					...(dto.optOutKeywords === undefined ? {} : { optOutKeywords: dto.optOutKeywords }),
					...(dto.helpKeywords === undefined ? {} : { helpKeywords: dto.helpKeywords }),
					embeddedLink: dto.embeddedLink ?? false,
					ageGated: dto.ageGated ?? false,
					...quietHoursColumns(dto.quietHours),
					status: "draft" satisfies MessagingCampaignStatus,
				}),
		);

		const [sample1, ...restSamples] = dto.sampleMessages;
		const submitted = await carrier.tenDlc.createCampaign({
			brandId: brand.carrierBrandId,
			usecase: dto.useCase,
			description: dto.description,
			// The DTO guarantees two to five samples, so `sample1` is present; the rest are spread
			// positionally because TCR's contract is five numbered fields and not an array.
			sample1: sample1 ?? dto.description,
			...(restSamples[0] === undefined ? {} : { sample2: restSamples[0] }),
			...(restSamples[1] === undefined ? {} : { sample3: restSamples[1] }),
			...(restSamples[2] === undefined ? {} : { sample4: restSamples[2] }),
			...(restSamples[3] === undefined ? {} : { sample5: restSamples[3] }),
			messageFlow: dto.messageFlow,
			helpMessage: dto.helpMessage,
			...(dto.optOutMessage === undefined ? {} : { optoutMessage: dto.optOutMessage }),
			...(dto.optInKeywords === undefined ? {} : { optinKeywords: dto.optInKeywords }),
			...(dto.optOutKeywords === undefined ? {} : { optoutKeywords: dto.optOutKeywords }),
			...(dto.helpKeywords === undefined ? {} : { helpKeywords: dto.helpKeywords }),
			embeddedLink: dto.embeddedLink ?? false,
			ageGated: dto.ageGated ?? false,
			// This platform answers STOP and HELP itself (see `messaging-inbound.service.ts`), so the
			// campaign declares that it handles them rather than leaving the registry to assume a
			// carrier-side responder that does not exist.
			subscriberOptin: true,
			subscriberOptout: true,
			subscriberHelp: true,
			...(this.env.MESSAGING_DRIVER === "telnyx" ? {} : { mock: true }),
		});

		const status = mapCampaignStatus(submitted.campaignStatus ?? submitted.status);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await updateCampaign(transaction, created.id, {
					carrierCampaignId: submitted.campaignId,
					status,
					statusReason: submitted.failureReasons ?? campaignStatusReason(status),
					lastPolledAt: new Date(),
				}),
		);
		logger.info(
			{
				organizationId,
				campaignId: created.id,
				carrierCampaignId: submitted.campaignId,
				status,
			},
			"a 10DLC campaign was submitted to the registry",
		);
		return row ?? created;
	}

	/**
	 * Edits a campaign's local record.
	 *
	 * Local ONLY, and knowingly so: TCR treats an approved campaign's use case, samples and message
	 * flow as the thing it approved, and a mid-flight edit is a resubmission, not a PATCH. What this
	 * writes is what the platform shows and what the send gate reads for quiet hours — the registry's
	 * copy changes when a campaign is resubmitted, which is a separate act with a separate fee.
	 */
	async updateCampaign(
		session: AppSession,
		id: string,
		dto: UpdateCampaignDto,
	): Promise<CampaignRow> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.database.withTenantScope(organizationId, async (transaction) => {
			if ((await getCampaign(transaction, id)) === undefined) {
				throw new MessagingNotFoundException("campaign");
			}
			const patch: Record<string, unknown> = {};
			for (const key of [
				"name",
				"description",
				"messageFlow",
				"helpMessage",
				"optOutMessage",
				"optInKeywords",
				"optOutKeywords",
				"helpKeywords",
				"embeddedLink",
				"ageGated",
			] as const) {
				const value = dto[key];
				if (value !== undefined) {
					patch[key] = value;
				}
			}
			if (dto.sampleMessages !== undefined) {
				patch.sampleMessages = [...dto.sampleMessages];
			}
			if (dto.quietHours !== undefined) {
				// The trio moves together or not at all — the schema has a check constraint saying so,
				// and a half-set window is a send gate with an undefined edge.
				Object.assign(patch, quietHoursColumns(dto.quietHours));
			}
			return await updateCampaign(transaction, id, patch);
		});
		if (row === undefined) {
			throw new MessagingNotFoundException("campaign");
		}
		return row;
	}

	// ---- number assignment -------------------------------------------------------------------

	/**
	 * Attaches one local number to an active campaign.
	 *
	 * Both refusals below are conditions the carrier ALSO enforces, restated here because the
	 * carrier's version of each is a 422 whose body names neither the campaign nor the number. The
	 * toll-free one especially: a toll-free DID assigned to a 10DLC campaign is not a slow path, it
	 * is the wrong registry entirely, and an admin who tries it needs to be sent to toll-free
	 * verification rather than told "invalid".
	 */
	async assignNumber(
		session: AppSession,
		campaignId: string,
		dto: AssignCampaignNumberDto,
	): Promise<MessagingNumberRow> {
		const organizationId = requireActiveOrganizationId(session);
		const carrier = this.requireCarrier();

		const { campaign, number } = await this.database.withTenantScope(
			organizationId,
			async (transaction) => {
				const campaignRow = await getCampaign(transaction, campaignId);
				if (campaignRow === undefined) {
					throw new MessagingNotFoundException("campaign");
				}
				const numberRow = await getMessagingNumber(transaction, dto.messagingNumberId);
				if (numberRow === undefined) {
					throw new MessagingNotFoundException("number");
				}
				return { campaign: campaignRow, number: numberRow };
			},
		);

		if (campaign.status !== "active" || campaign.carrierCampaignId === null) {
			throw new MessagingRegistrationStateException(
				`Campaign "${campaign.name}" is ${campaign.status}; the carriers accept a number ` +
					"assignment only on an active campaign.",
			);
		}
		if (number.numberClass !== "local") {
			throw new MessagingRegistrationStateException(
				`${number.e164} is a ${number.numberClass} number: it registers by toll-free ` +
					"verification, not by 10DLC campaign assignment.",
			);
		}

		try {
			await carrier.tenDlc.assignPhoneNumber(number.e164, campaign.carrierCampaignId);
		} catch (error) {
			// The number is left exactly as it was — unregistered, with whatever reason it already
			// carried. Writing `campaignId` on a failed assignment would make the send gate believe a
			// registration that the carriers do not have.
			throw new MessagingRegistrationStateException(
				`The carrier refused to assign ${number.e164} to "${campaign.name}": ${errorMessage(error)}`,
			);
		}

		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await updateMessagingNumber(transaction, number.id, {
					campaignId: campaign.id,
					registrationStatus: "registered",
					registrationReason: null,
				}),
		);
		logger.info(
			{ organizationId, messagingNumberId: number.id, campaignId: campaign.id },
			"a messaging number was assigned to a 10DLC campaign",
		);
		return row ?? number;
	}

	/**
	 * Detaches a number from its campaign.
	 *
	 * The carrier call comes first here — the reverse of the create paths — because the asymmetry
	 * runs the other way: a number that is unassigned locally but still attached at the registry
	 * would keep sending traffic this platform believes it has stopped, which is the state the whole
	 * send gate exists to make impossible.
	 */
	async unassignNumber(
		session: AppSession,
		campaignId: string,
		messagingNumberId: string,
	): Promise<MessagingNumberRow> {
		const organizationId = requireActiveOrganizationId(session);
		const carrier = this.requireCarrier();

		const number = await this.database.withTenantScope(organizationId, async (transaction) => {
			if ((await getCampaign(transaction, campaignId)) === undefined) {
				throw new MessagingNotFoundException("campaign");
			}
			return await getMessagingNumber(transaction, messagingNumberId);
		});
		if (number === undefined || number.campaignId !== campaignId) {
			throw new MessagingNotFoundException("number");
		}

		await carrier.tenDlc.unassignPhoneNumber(number.e164);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await updateMessagingNumber(transaction, number.id, {
					campaignId: null,
					registrationStatus: "unregistered",
					registrationReason:
						"This number is not assigned to an approved 10DLC campaign. Assign it to an " +
						"active campaign to start sending again.",
				}),
		);
		return row ?? number;
	}

	// ---- toll-free verification --------------------------------------------------------------

	async listTollFreeVerifications(session: AppSession, query: ListQuery) {
		const organizationId = requireActiveOrganizationId(session);
		const pagination = normalizePagination(query);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const { rows, total } = await listTollFreeVerifications(transaction, pagination);
			return paged(rows, total, pagination);
		});
	}

	/**
	 * Files one toll-free verification with the aggregators.
	 *
	 * The carrier's input is camelCase with a SCREAMING `URL` suffix and a singular "Condition"
	 * (`privacyPolicyURL`, `termsAndConditionURL`) — the aggregator's contract, not a typo. The DTO
	 * spells them the way the rest of this API does, and this method is the one place the two
	 * spellings meet; see `toll-free-verification.ts`.
	 *
	 * The number is moved to `pending` in the same pass. A toll-free number that has been submitted
	 * but not yet verified is not "unregistered with nothing happening", and an admin watching the
	 * settings page needs to see the difference or they will submit again.
	 */
	async submitTollFreeVerification(
		session: AppSession,
		dto: SubmitTollFreeVerificationDto,
	): Promise<TollFreeVerificationRow> {
		const organizationId = requireActiveOrganizationId(session);
		const carrier = this.requireCarrier();

		const number = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getMessagingNumber(transaction, dto.messagingNumberId),
		);
		if (number === undefined) {
			throw new MessagingNotFoundException("number");
		}
		if (number.numberClass !== "toll-free") {
			throw new MessagingRegistrationStateException(
				`${number.e164} is a ${number.numberClass} number: it registers through a 10DLC brand ` +
					"and campaign, not through toll-free verification.",
			);
		}

		const created = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await insertTollFreeVerification(transaction, {
					organizationId,
					messagingNumberId: number.id,
					businessName: dto.businessName,
					corporateWebsite: dto.corporateWebsite,
					businessAddr1: dto.businessAddr1,
					businessAddr2: dto.businessAddr2 ?? null,
					businessCity: dto.businessCity,
					businessState: dto.businessState,
					businessZip: dto.businessZip,
					businessContactFirstName: dto.businessContactFirstName,
					businessContactLastName: dto.businessContactLastName,
					businessContactEmail: dto.businessContactEmail,
					businessContactPhone: dto.businessContactPhone,
					businessRegistrationNumber: dto.businessRegistrationNumber,
					businessRegistrationType: dto.businessRegistrationType,
					businessRegistrationCountry: dto.businessRegistrationCountry,
					useCase: dto.useCase,
					useCaseSummary: dto.useCaseSummary,
					productionMessageContent: dto.productionMessageContent,
					optInWorkflow: dto.optInWorkflow,
					optInWorkflowImageUrls: [...dto.optInWorkflowImageUrls],
					messageVolume: dto.messageVolume,
					privacyPolicyUrl: dto.privacyPolicyUrl,
					termsAndConditionsUrl: dto.termsAndConditionsUrl,
					status: "pending" satisfies TollFreeVerificationStatus,
				}),
		);

		const submitted = await carrier.tollFreeVerification.submit({
			businessName: dto.businessName,
			corporateWebsite: dto.corporateWebsite,
			businessAddr1: dto.businessAddr1,
			...(dto.businessAddr2 === undefined ? {} : { businessAddr2: dto.businessAddr2 }),
			businessCity: dto.businessCity,
			businessState: dto.businessState,
			businessZip: dto.businessZip,
			businessContactFirstName: dto.businessContactFirstName,
			businessContactLastName: dto.businessContactLastName,
			businessContactEmail: dto.businessContactEmail,
			businessContactPhone: dto.businessContactPhone,
			businessRegistrationNumber: dto.businessRegistrationNumber,
			businessRegistrationType: dto.businessRegistrationType,
			businessRegistrationCountry: dto.businessRegistrationCountry,
			messageVolume: dto.messageVolume,
			phoneNumbers: [{ phoneNumber: number.e164 }],
			useCase: dto.useCase,
			useCaseSummary: dto.useCaseSummary,
			productionMessageContent: dto.productionMessageContent,
			optInWorkflow: dto.optInWorkflow,
			optInWorkflowImageURLs: dto.optInWorkflowImageUrls.map((url) => ({ url })),
			privacyPolicyURL: dto.privacyPolicyUrl,
			termsAndConditionURL: dto.termsAndConditionsUrl,
		});

		const status = mapTollFreeStatus(submitted.verificationStatus);
		const row = await this.database.withTenantScope(organizationId, async (transaction) => {
			const updated = await updateTollFreeVerification(transaction, created.id, {
				carrierVerificationId: submitted.verificationRequestId ?? submitted.id,
				status,
				statusReason: submitted.rejectionReason ?? submitted.reason ?? tollFreeStatusReason(status),
				lastPolledAt: new Date(),
			});
			await updateMessagingNumber(transaction, number.id, {
				registrationStatus: "pending",
				registrationReason:
					"Toll-free verification has been submitted and is under review by the aggregators.",
			});
			return updated;
		});
		logger.info(
			{ organizationId, verificationId: created.id, messagingNumberId: number.id, status },
			"a toll-free verification was submitted",
		);
		return row ?? created;
	}

	/** Every write path needs a carrier; the reads above deliberately do not. See the header. */
	private requireCarrier(): TelnyxClient {
		if (this.carrier === undefined) {
			throw new MessagingNotConfiguredException();
		}
		return this.carrier;
	}
}

/**
 * TCR's `identityStatus` to this schema's brand status.
 *
 * Exported and pure so the create path and the poller cannot disagree — see the class header. An
 * UNKNOWN member maps to `pending` rather than `failed`: the registry adds statuses on its own
 * schedule, and reading a new one as a terminal failure would strand a brand that is simply moving.
 */
export function mapBrandStatus(identityStatus: string | null | undefined): MessagingBrandStatus {
	switch (identityStatus) {
		case "VERIFIED":
			return "verified";
		case "VETTED_VERIFIED":
			return "vetted-verified";
		case "SELF_DECLARED":
			return "self-declared";
		case "UNVERIFIED":
			return "unverified";
		case "PENDING":
			return "pending";
		default:
			return "pending";
	}
}

/**
 * Telnyx/TCR campaign status to this schema's.
 *
 * The `TCR_*` members are the registry's own view and the bare ones are Telnyx's; they mean the same
 * thing and are folded together here rather than kept apart in the column, because nothing in this
 * platform branches on WHICH of the two systems noticed. An unknown member is `pending` for the same
 * reason as the brand map.
 */
export function mapCampaignStatus(status: string | null | undefined): MessagingCampaignStatus {
	switch (status) {
		case "ACTIVE":
			return "active";
		case "TCR_PENDING":
		case "PENDING":
			return "pending";
		case "TCR_EXPIRED":
		case "EXPIRED":
			return "expired";
		case "TCR_SUSPENDED":
			return "suspended";
		case "TCR_FAILED":
		case "FAILED":
			return "rejected";
		default:
			return "pending";
	}
}

/**
 * The aggregator's Title-Case status to this schema's.
 *
 * `Waiting For Customer` and `Waiting For Vendor` both collapse into `in-review`. They are different
 * facts — one of them is waiting on the tenant — but the carrier does not say WHAT it is waiting for,
 * so a distinct status would be a state an admin can see and cannot act on. The reason string
 * carries the aggregator's own words instead.
 */
export function mapTollFreeStatus(
	verificationStatus: string | null | undefined,
): TollFreeVerificationStatus {
	switch (verificationStatus) {
		case "Verified":
			return "verified";
		case "Rejected":
			return "rejected";
		case "In Review":
		case "In Progress":
		case "Waiting For Customer":
		case "Waiting For Vendor":
			return "in-review";
		case "Pending":
			return "pending";
		default:
			return "pending";
	}
}

/** The sentence a brand carries when the registry gave no words of its own. */
export function brandStatusReason(status: MessagingBrandStatus): string | null {
	switch (status) {
		case "verified":
		case "vetted-verified":
			return null;
		case "failed":
			return "The registry rejected this brand. Correct the details and resubmit.";
		case "self-declared":
			return "This brand is self-declared. Campaign throughput stays at the lowest tier until it is vetted.";
		case "unverified":
			return "The registry could not verify this brand's identity from the details given.";
		default:
			return "Vetting is in progress at The Campaign Registry.";
	}
}

/** The sentence a campaign carries when the registry gave no words of its own. */
export function campaignStatusReason(status: MessagingCampaignStatus): string | null {
	switch (status) {
		case "active":
			return null;
		case "suspended":
			return "The carriers suspended this campaign. Its numbers cannot send until it is reinstated.";
		case "expired":
			return "This campaign has expired at the registry and must be renewed.";
		case "rejected":
			return "The registry rejected this campaign. Correct the use case and samples, then resubmit.";
		default:
			return "The registry is reviewing this campaign.";
	}
}

/** The sentence a toll-free verification carries when the aggregator gave none. */
export function tollFreeStatusReason(status: TollFreeVerificationStatus): string | null {
	switch (status) {
		case "verified":
			return null;
		case "rejected":
			return "The aggregators rejected this verification. Correct the submission and file it again.";
		case "in-review":
			return "The aggregators are reviewing this submission.";
		default:
			return "This submission is queued with the aggregators.";
	}
}

/**
 * The quiet-hours trio, as an atomic patch.
 *
 * All three columns are always in the returned object — `null` clears the window — because writing
 * only the two that changed is how a window with an undefined edge gets into the send gate. The
 * schema has a check constraint saying the same thing; this is the half that keeps the constraint
 * from being the first thing to notice.
 */
function quietHoursColumns(quietHours: CreateCampaignDto["quietHours"]): Record<string, unknown> {
	if (
		quietHours === undefined ||
		quietHours === null ||
		quietHours.start === undefined ||
		quietHours.end === undefined
	) {
		return {
			quietHoursStartMinute: null,
			quietHoursEndMinute: null,
			quietHoursTimeZone: null,
		};
	}
	return {
		quietHoursStartMinute: quietHours.start,
		quietHoursEndMinute: quietHours.end,
		quietHoursTimeZone: quietHours.timeZone,
	};
}

/**
 * The OTP precondition, in one place because trigger and verify share it exactly.
 *
 * Returns the carrier brand id so the caller cannot forget the null check that comes with it.
 */
function requireSoleProprietorOtp(brand: BrandRow): string {
	if (brand.entityType !== "SOLE_PROPRIETOR") {
		throw new MessagingRegistrationStateException(
			`Brand "${brand.displayName}" is a ${brand.entityType} brand, which vets against its ` +
				"registration number rather than an SMS PIN. Only a SOLE_PROPRIETOR brand uses the OTP flow.",
		);
	}
	if (brand.carrierBrandId === null) {
		throw new MessagingRegistrationStateException(
			`Brand "${brand.displayName}" has not reached the registry yet, so there is nothing to ` +
				"send a PIN for. Resubmit the brand first.",
		);
	}
	return brand.carrierBrandId;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
