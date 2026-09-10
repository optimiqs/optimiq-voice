import { Body, Controller, Get, Inject, Param, Post, Put } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { FraudAnomalyDetector } from "./fraud-anomaly-detector.service";
import {
	suspendExtensionOutboundDto,
	writeExtensionTollFraudOverrideDto,
	writeTollFraudPolicyDto,
} from "./toll-fraud.dto";
import { TollFraudService } from "./toll-fraud.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/toll-fraud` — spend and velocity controls on international calling.
 *
 * The organization policy is a SINGLETON reached without an id, exactly like `/api/v1/org-limits`:
 * one row per organization, and an id would be a detail of the table every caller had to fetch
 * first. The per-extension overrides hang off it as a collection keyed on the extension id, which is
 * the id the caller already has — an override has no identity of its own that anybody outside this
 * table would use.
 *
 * ## Why the two grants are not `org-limits`' two, and not `security`'s two
 *
 * `org-limits.write` is owner-only because a quota an administrator can raise is not a quota. That
 * argument does not transfer: a fraud threshold is tuned DURING an incident, at speed, by whoever is
 * watching the alerts, and requiring the owner to be awake for it would mean the control is loosened
 * by switching it off. `security.*` is the other near-miss — it is the NETWORK boundary, read by
 * whoever runs the SIP edge during a carrier turn-up, and the person investigating a fraud alert is
 * not usually that person.
 *
 * `toll-fraud.read` is deliberately wide (a manager holds it), because "why can this phone not call
 * Germany?" is a question a manager fields and a manager who cannot see the answer experiences the
 * control as a dial tone that gives up.
 */
@Controller("api/v1/toll-fraud")
export class TollFraudController {
	constructor(
		@Inject(TollFraudService) private readonly tollFraud: TollFraudService,
		@Inject(FraudAnomalyDetector) private readonly detector: FraudAnomalyDetector,
	) {}

	/**
	 * Runs the anomaly sweep NOW, instead of waiting for its hourly tick.
	 *
	 * ## Why this exists
	 *
	 * The detector is an hourly timer, which makes the one thing an operator most wants to do with it
	 * — see whether their alerting actually works, end to end, on their own numbers — a thing they
	 * can only do by waiting up to an hour and hoping. That is also what made the delivery of
	 * `security.fraud-signal` unprovable: a subscription, a receiver and a spike are all in place and
	 * nothing fires them.
	 *
	 * ## Why it is a WRITE grant
	 *
	 * The sweep is not a read. It raises signals, writes audit rows, delivers webhooks and — when the
	 * organization has asked for it — suspends an extension's outbound calling. Anything that can
	 * suspend a phone belongs behind the grant that configures the policy, not behind the one that
	 * reads it.
	 *
	 * The pass is CROSS-TENANT by construction (it asks every organization with events in the
	 * window), exactly as the timer's is; the session is what authorises the trigger, not what scopes
	 * the sweep. Re-entrancy is refused inside the detector, so a second press while one is running
	 * is a no-op rather than a double set of signals.
	 */
	@Post("anomaly-scan")
	@RequirePermissions("toll-fraud.write")
	async runAnomalyScan(@Session() _session: AppSession) {
		const findings = await this.detector.pass();
		return {
			data: {
				// The tenant ids are deliberately NOT echoed. The sweep is cross-tenant by construction,
				// so returning them would hand one organization's operator the identifiers of every
				// other organization that raised a signal in the same hour — and this file's own rule
				// (asserted by `tollFraudPolicy.test.ts`) is that an organization id never appears on a
				// controller at all. The signals themselves reach each tenant by webhook.
				findings: findings.map((finding) => ({
					kind: finding.kind,
					severity: finding.severity,
					...(finding.extensionNumber === undefined
						? {}
						: { extensionNumber: finding.extensionNumber }),
					summary: finding.summary,
				})),
				stats: this.detector.stats,
			},
		};
	}

	/** The organization's policy, or `null` when it has none — which means unconstrained. */
	@Get("policy")
	@RequirePermissions("toll-fraud.read")
	async readPolicy(@Session() session: AppSession) {
		return await this.tollFraud.readPolicy(session);
	}

	@Put("policy")
	@RequirePermissions("toll-fraud.write")
	async writePolicy(@Session() session: AppSession, @Body() body: unknown) {
		return await this.tollFraud.writePolicy(session, parseDto(writeTollFraudPolicyDto, body));
	}

	/**
	 * Current usage against the ceilings.
	 *
	 * Under `read` rather than a grant of its own, for the reason `/api/v1/org-limits/usage` gives:
	 * usage without limits is a statistic nobody asked for and limits without usage is a number
	 * nobody can act on. They are one screen.
	 */
	@Get("usage")
	@RequirePermissions("toll-fraud.read")
	async usage(@Session() session: AppSession) {
		return { data: await this.tollFraud.usage(session) };
	}

	/** Every per-extension override, including the suspended ones. */
	@Get("overrides")
	@RequirePermissions("toll-fraud.read")
	async listOverrides(@Session() session: AppSession) {
		return await this.tollFraud.listOverrides(session);
	}

	@Put("overrides/:extensionId")
	@RequirePermissions("toll-fraud.write")
	async writeOverride(
		@Session() session: AppSession,
		@Param("extensionId") extensionId: string,
		@Body() body: unknown,
	) {
		return await this.tollFraud.writeOverride(
			session,
			extensionId,
			parseDto(writeExtensionTollFraudOverrideDto, body),
		);
	}

	/**
	 * Suspend or restore one extension's outbound calling.
	 *
	 * Its own endpoint rather than a field on the override body, because it is a different act with a
	 * different lifecycle: an override is configuration somebody tunes, and a suspension is an
	 * incident response somebody takes at speed and reverses when the investigation closes. Folding
	 * it in would mean restoring a phone requires resending every ceiling that phone happens to have.
	 */
	@Put("overrides/:extensionId/suspension")
	@RequirePermissions("toll-fraud.write")
	async suspend(
		@Session() session: AppSession,
		@Param("extensionId") extensionId: string,
		@Body() body: unknown,
	) {
		return await this.tollFraud.suspendExtension(
			session,
			extensionId,
			parseDto(suspendExtensionOutboundDto, body),
		);
	}
}
