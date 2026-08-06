import { getLogger } from "@optimiq-voice/logger";
import { createTelnyxClient, type TelnyxClient } from "@optimiq-voice/telnyx";
import { loadCarrierEnv } from "./carrier-env";
import { CARRIER_ENV, TELNYX_CLIENT } from "./carrier.tokens";
import type { CarrierEnv } from "./carrier-env";
import type { Provider } from "@nestjs/common";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * The carrier slice's providers, kept out of `pbx.module.ts` so that file stays a list of what the
 * area contains rather than a place where one slice's construction logic lives.
 *
 * The client is built once at boot, not per request: it holds no per-call state, and rebuilding it
 * would mean re-reading the environment on a request path that must not be able to fail for
 * configuration reasons.
 */
export const carrierProviders: readonly Provider[] = [
	{ provide: CARRIER_ENV, useFactory: (): CarrierEnv => loadCarrierEnv() },
	{
		provide: TELNYX_CLIENT,
		useFactory: (env: CarrierEnv): TelnyxClient | undefined => {
			if (env.TELNYX_API_KEY === undefined) {
				logger.info(
					"no TELNYX_API_KEY — carrier endpoints answer 503 CARRIER_NOT_CONFIGURED; " +
						"every other PBX endpoint is unaffected.",
				);
				return undefined;
			}
			logger.info("carrier configured", {
				provider: "telnyx",
				baseUrl: env.TELNYX_API_BASE,
				sipRegion: env.TELNYX_SIP_REGION,
				webhooks: env.TELNYX_PUBLIC_KEY === undefined ? "unverifiable" : "verified",
			});
			return createTelnyxClient({
				apiKey: env.TELNYX_API_KEY,
				baseUrl: env.TELNYX_API_BASE,
				/**
				 * Every attempt is logged, including the ones that succeeded on the second try.
				 *
				 * A retry that silently repaired a 429 is exactly the signal that tells an operator
				 * the platform is approaching the shared rate limit — and it is invisible from the
				 * outside, because the request succeeded.
				 */
				onAttempt: (event) => {
					if (event.error !== undefined || (event.status ?? 200) >= 400) {
						logger.warn("carrier request attempt failed", {
							method: event.method,
							path: event.path,
							attempt: event.attempt,
							status: event.status,
							retryInMs: event.retryInMs,
						});
					}
				},
			});
		},
		inject: [CARRIER_ENV],
	},
];
