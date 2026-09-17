import { getLogger } from "@optimiq-voice/logging";
import { createTelnyxClient } from "@optimiq-voice/telnyx";
import { loadCarrierEnv } from "../pbx/carrier/carrier-env";
import { CARRIER_ENV, TELNYX_CLIENT } from "../pbx/carrier/carrier.tokens";
import { createObjectStore, loadStorageEnv } from "../storage";
import { loadMessagingEnv } from "./messaging-env";
import { MESSAGING_ENV, MESSAGING_PROVIDER, MESSAGING_STORE } from "./messaging.tokens";
import { FakeMessagingProvider } from "./provider/fake-messaging.provider";
import { TelnyxMessagingProvider } from "./provider/telnyx-messaging.provider";
import type { CarrierEnv } from "../pbx/carrier/carrier-env";
import type { ObjectStore } from "../storage";
import type { MessagingEnv } from "./messaging-env";
import type { MessagingProvider } from "./provider/messaging-provider.port";
import type { Provider } from "@nestjs/common";
import type { TelnyxClient } from "@optimiq-voice/telnyx";

const logger = getLogger("api.messaging");

/**
 * The messaging area's providers, kept out of the module file so that stays a list of what the area
 * contains rather than a place where construction logic lives — the same split `carrier.providers.ts`
 * makes.
 *
 * # Why the fake is constructible in a real process
 *
 * `MESSAGING_DRIVER=fake` is not a test-only escape hatch that happens to be reachable; it is the
 * supported way to run this feature on a machine with no carrier account. Two-way messaging cannot
 * otherwise be exercised locally at all: the real thing needs a Telnyx account, a vetted 10DLC brand,
 * an approved campaign, and a webhook URL the public internet can reach. Refusing to ship a fake
 * would mean nobody could see the inbox work before production.
 *
 * The obvious risk — a production deployment silently running the fake — is answered by making it
 * loud rather than by making it impossible: the driver is logged at boot with a warning that names
 * it, the provider reports `name: "fake"` on the health surface, and nothing about it is the
 * default. `none` is the default, and `none` means the endpoints answer 503.
 */
export const messagingProviders: readonly Provider[] = [
	{ provide: MESSAGING_ENV, useFactory: (): MessagingEnv => loadMessagingEnv() },
	/**
	 * The carrier env and client, provided under the CARRIER tokens but scoped to this module.
	 *
	 * `PbxModule` builds the same two and does not export them, and asking it to would widen a
	 * neighbouring area's public surface for one consumer. Nest resolves providers per module, so
	 * declaring them here gives messaging its own instances under the same token names — which is
	 * what `messaging-registration.service.ts` injects, and what keeps this area's dependency on the
	 * carrier explicit rather than inherited.
	 *
	 * The duplicate client costs nothing: it holds no per-call state, and `carrier.providers.ts`
	 * already makes that argument for building it once at boot rather than per request. The one
	 * thing that is NOT duplicated is the environment contract — both call `loadCarrierEnv`, which
	 * reads the same variables and fails the same way.
	 */
	{ provide: CARRIER_ENV, useFactory: (): CarrierEnv => loadCarrierEnv() },
	{
		provide: TELNYX_CLIENT,
		/**
		 * Under `MESSAGING_DRIVER=fake` this stands the carrier package's own in-process fake server
		 * up and points a REAL `TelnyxClient` at it.
		 *
		 * That is deliberately not a hand-written double of `tenDlc` and `tollFreeVerification`. The
		 * registration flows are the half of this feature with the most carrier-shaped behaviour in
		 * them — camelCase bodies, a status vocabulary that is not ours, an assignment the carrier
		 * refuses unless the campaign is ACTIVE — and a local double would agree with whatever this
		 * code happened to send. Driving the real client against the package's fake means the request
		 * shapes, the schemas and the error mapping are all exercised, and the one rule the whole
		 * 10DLC feature exists to anticipate (an unregistered number cannot be assigned, and cannot
		 * send) is enforced by something that is not the code under test.
		 *
		 * The `/fake` subpath is imported DYNAMICALLY and only on this branch, so a deployment running
		 * any other driver never loads it — which is the property the package's subpath split exists
		 * to protect.
		 */
		useFactory: async (
			env: MessagingEnv,
			carrierEnv: CarrierEnv,
		): Promise<TelnyxClient | undefined> => {
			if (env.MESSAGING_DRIVER === "fake") {
				const { startFakeTelnyxServer } = await import("@optimiq-voice/telnyx/fake");
				const server = await startFakeTelnyxServer();
				// Registrations are free and instant here; the flag is what lets a proof send from a
				// number before its campaign has been through the assignment step, and it is off by
				// default so the refusal stays testable.
				server.state.allowUnregisteredSend = false;
				logger.warn(
					{ baseUrl: server.baseUrl },
					"MESSAGING_DRIVER=fake — 10DLC and toll-free registration run against the " +
						"in-process fake carrier. No registration is filed with a real registry.",
				);
				return createTelnyxClient({ apiKey: "fake-key", baseUrl: server.baseUrl });
			}
			return carrierEnv.TELNYX_API_KEY === undefined
				? undefined
				: createTelnyxClient({
						apiKey: carrierEnv.TELNYX_API_KEY,
						baseUrl: carrierEnv.TELNYX_API_BASE,
					});
		},
		inject: [MESSAGING_ENV, CARRIER_ENV],
	},
	{
		provide: MESSAGING_STORE,
		// The platform storage env decides the DRIVER (local, or local mirrored to S3) and the
		// messaging env decides only the root, exactly as the fax and voicemail stores are built. A
		// deployment that mirrors recordings to S3 mirrors MMS parts too, without a second decision.
		useFactory: (env: MessagingEnv): ObjectStore =>
			createObjectStore(loadStorageEnv(), { root: env.MESSAGING_OBJECT_ROOT }),
		inject: [MESSAGING_ENV],
	},
	{
		provide: MESSAGING_PROVIDER,
		useFactory: (
			env: MessagingEnv,
			carrierEnv: CarrierEnv,
			telnyx: TelnyxClient | undefined,
		): MessagingProvider | undefined => {
			if (env.MESSAGING_DRIVER === "none") {
				logger.info(
					"no MESSAGING_DRIVER — messaging endpoints answer 503 MESSAGING_NOT_CONFIGURED; " +
						"every other endpoint is unaffected.",
				);
				return undefined;
			}
			if (env.MESSAGING_DRIVER === "fake") {
				logger.warn(
					{ driver: "fake" },
					"MESSAGING_DRIVER=fake — messages are accepted by an in-process double and never " +
						"reach a carrier. This is for local development and tests only.",
				);
				return new FakeMessagingProvider({
					// The webhook secret doubles as the fake's shared secret with whatever is driving it.
					// Deliberately derived from an env var with a visible default rather than generated:
					// a generated one would change on every restart, and the proof script would have no
					// way to sign a delivery.
					webhookSecret: process.env.MESSAGING_FAKE_WEBHOOK_SECRET ?? "fake-messaging-secret",
				});
			}
			if (telnyx === undefined || carrierEnv.TELNYX_PUBLIC_KEY === undefined) {
				// Both halves are required and they are separately optional in the carrier env, so this
				// says which one is missing rather than "messaging is broken".
				logger.error(
					{
						hasApiKey: telnyx !== undefined,
						hasPublicKey: carrierEnv.TELNYX_PUBLIC_KEY !== undefined,
					},
					"MESSAGING_DRIVER=telnyx but the carrier is not fully configured — messaging " +
						"endpoints will answer 503. Both TELNYX_API_KEY and TELNYX_PUBLIC_KEY are required.",
				);
				return undefined;
			}
			logger.info({ driver: "telnyx" }, "messaging configured");
			return new TelnyxMessagingProvider(
				telnyx,
				carrierEnv.TELNYX_PUBLIC_KEY,
				env.MESSAGING_PUBLIC_BASE_URL === undefined
					? undefined
					: `${env.MESSAGING_PUBLIC_BASE_URL.replace(/\/$/u, "")}/api/v1/messaging/webhooks/telnyx`,
			);
		},
		inject: [MESSAGING_ENV, CARRIER_ENV, TELNYX_CLIENT],
	},
];
