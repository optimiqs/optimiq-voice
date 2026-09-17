/**
 * The messaging provider seam.
 *
 * # Why a port here when `@optimiq-voice/telnyx` is already a seam
 *
 * The carrier package is a seam against the HTTP API — it makes "swap carriers" a matter of writing
 * a sibling package. This port is a seam against something narrower and more useful day to day: the
 * four things the messaging feature actually needs a carrier to do. Voice never needed one because
 * the engine talks SIP and the carrier client is only reached from a provisioning path; messaging is
 * different, because the *request path a user is waiting on* and the *webhook that closes the loop*
 * are both carrier round trips.
 *
 * Concretely, this port is what makes the whole feature drivable with no carrier account, no public
 * webhook URL and no network — {@link FakeMessagingProvider} implements it in-process, records every
 * send, and can be told to deliver an inbound message. That is what the api tests run against and
 * what the local-stack proof uses.
 *
 * # What is deliberately NOT on this interface
 *
 * No opt-out handling, no keyword classification, no quiet hours, no registration gate. Every one of
 * those is a decision this platform must be able to make and defend when the carrier is unreachable
 * (see `compliance/keywords.ts`), so they live above the port. A provider that offered to handle
 * STOP for us would still not be allowed to: the ledger has to be ours.
 *
 * No conversation, no organization, no `messaging_number` row either — the port speaks E.164 and
 * opaque carrier ids, exactly as the telnyx package speaks HTTP. Domain shape stays in the service.
 */

/** What a send needs. `clientState` is our correlation token, echoed on every delivery receipt. */
export interface ProviderSendInput {
	readonly from: string;
	readonly to: string;
	readonly text?: string | undefined;
	/**
	 * Publicly-fetchable URLs for MMS parts.
	 *
	 * URLs and not bytes, because that is what every carrier's send API takes — it fetches the media
	 * itself. The service turns object-store keys into signed, expiring URLs immediately before the
	 * send, which is also why an MMS whose link TTL is shorter than the send queue's backlog would
	 * fail: the TTL is checked against the queue's lease in `messaging-send-worker.service.ts`.
	 */
	readonly mediaUrls?: readonly string[] | undefined;
	/** Our `message.id`. Echoed back by the carrier so a receipt correlates without a lookup table. */
	readonly clientState: string;
	/** The carrier-side profile the number sends through, when the deployment configured one. */
	readonly messagingProfileId?: string | undefined;
}

export interface ProviderSendResult {
	/** The carrier's message id. The correlation key for a receipt that lost the client state. */
	readonly carrierMessageId: string;
	/** Segments the carrier says this will bill as, when it says at accept time. */
	readonly segments?: number | undefined;
}

/**
 * The four statuses this platform models, after the provider has translated its own vocabulary.
 *
 * Translation happens in the provider adapter and not here, so the domain never learns a carrier's
 * words. `sent` and `delivered` are distinct because the difference between "the carrier took it"
 * and "the handset's network acknowledged it" is exactly what tells a working number from a filtered
 * one — see `message_status` in the schema.
 */
export type ProviderMessageStatus = "sent" | "delivered" | "failed" | "received";

/** A delivery receipt or an inbound message, normalised. Produced by the webhook path. */
export interface ProviderInboundMessage {
	readonly carrierMessageId: string;
	readonly from: string;
	readonly to: string;
	readonly text?: string | undefined;
	/** Carrier URLs for MMS parts, to be downloaded into the object store. */
	readonly mediaUrls?: readonly string[] | undefined;
	readonly receivedAt: Date;
}

export interface ProviderDeliveryReceipt {
	readonly carrierMessageId: string;
	/** Our `message.id`, when the carrier echoed the client state. */
	readonly clientState?: string | undefined;
	readonly status: ProviderMessageStatus;
	readonly segments?: number | undefined;
	readonly errorReason?: string | undefined;
	readonly occurredAt: Date;
}

/** A verified, parsed webhook: exactly one of the two things a messaging webhook can be. */
export type ProviderWebhookEvent =
	| { readonly kind: "inbound"; readonly message: ProviderInboundMessage }
	| { readonly kind: "receipt"; readonly receipt: ProviderDeliveryReceipt };

/** Everything the webhook route hands the provider to authenticate a delivery. */
export interface ProviderWebhookRequest {
	/** The EXACT bytes received. Never a re-serialisation — see `webhooks/signature.ts`. */
	readonly rawBody: Buffer;
	readonly headers: Readonly<Record<string, string | undefined>>;
}

/**
 * Raised when a delivery cannot be authenticated. Carries a machine-readable `reason` so a log line
 * distinguishes "somebody is probing us" from "our key is stale after a portal rotation".
 */
export class MessagingWebhookAuthError extends Error {
	readonly reason: string;
	constructor(reason: string, detail?: string) {
		super(`messaging webhook rejected (${reason})${detail === undefined ? "" : `: ${detail}`}`);
		this.name = "MessagingWebhookAuthError";
		this.reason = reason;
	}
}

/** Raised for a send the carrier refused. `permanent` decides whether the worker retries. */
export class MessagingSendError extends Error {
	readonly permanent: boolean;
	constructor(message: string, permanent: boolean) {
		super(message);
		this.name = "MessagingSendError";
		this.permanent = permanent;
	}
}

export interface MessagingProvider {
	/** Names the implementation, for the boot log and the 503's reason. */
	readonly name: string;

	/**
	 * Hands one message to the carrier. Resolves once the carrier has ACCEPTED it — never once it is
	 * delivered, which arrives later as a receipt.
	 *
	 * Implementations must not auto-retry: a retried send is a second text to a consumer and a second
	 * charge, the same argument `resources/faxes.ts` makes for `retryable: false`. The send worker
	 * owns retry, because only it knows how many attempts the row has spent.
	 */
	readonly send: (input: ProviderSendInput) => Promise<ProviderSendResult>;

	/**
	 * Authenticates and parses one webhook delivery.
	 *
	 * Throws {@link MessagingWebhookAuthError} when the delivery is not genuine — the route turns that
	 * into a 403. Returns `undefined` for a genuine delivery this platform does not model, which the
	 * route answers 200: retrying will never make it parse, and an endpoint that fails forever is one
	 * the carrier eventually disables, taking the events we DO care about with it.
	 */
	readonly parseWebhook: (
		request: ProviderWebhookRequest,
	) => Promise<ProviderWebhookEvent | undefined>;

	/**
	 * Downloads an MMS part into memory, bounded.
	 *
	 * On the port rather than on a shared fetcher because the URL's authentication is the provider's
	 * business — some carriers require the API key on media fetches — and because the fake serves its
	 * media from memory with no HTTP at all.
	 */
	readonly fetchMedia: (
		url: string,
	) => Promise<{ readonly bytes: Buffer; readonly contentType: string | undefined }>;

	/**
	 * Attaches a DID to the carrier-side messaging profile, or detaches it.
	 *
	 * Separate from registration: a profile attachment is what makes the number *reachable* by the
	 * messaging API at all, while a campaign assignment is what makes sending from it *permitted*.
	 * Conflating them produces a number that is enabled and silently filtered.
	 */
	readonly setNumberMessagingProfile: (
		carrierNumberRef: string,
		messagingProfileId: string | null,
	) => Promise<void>;
}
