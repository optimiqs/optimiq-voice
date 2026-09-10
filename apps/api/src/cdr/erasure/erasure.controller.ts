import { Body, Controller, Inject, Post } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseErasureSubject } from "./erasure.dto";
import { CdrErasureService } from "./erasure.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/erasure` — the right to be forgotten, as an endpoint.
 *
 * ## Its own prefix, not `/api/v1/recordings/erasure`
 *
 * The operation spans recordings, voicemail and the call ledger, and mounting it under any one of
 * their prefixes would state that it is a recordings feature — which is how the voicemail half
 * quietly stops being maintained. The URL names what the caller is asking for.
 *
 * ## Both routes are `POST`, including the preview
 *
 * The preview mutates nothing and is still not a `GET`, for two reasons that both matter. The
 * subject is a phone number, and a `GET` would put a named person's number in every access log,
 * proxy cache and browser history between here and the operator — on the one endpoint whose entire
 * purpose is to remove that number from where it has been written down. And a `GET` is prefetchable
 * and retryable by anything in the path, which is a poor property for the request that a UI shows
 * immediately before the irreversible one.
 */
@Controller("api/v1/erasure")
export class CdrErasureController {
	constructor(@Inject(CdrErasureService) private readonly erasure: CdrErasureService) {}

	/**
	 * Counts what an apply would destroy.
	 *
	 * `recordings.delete` and not `recordings.read`: the answer is a measure of how much of a named
	 * third party's personal data this tenant holds, and being able to ask that of an arbitrary
	 * number is the same capability as being able to destroy it — the confirmation dialog and the
	 * confirmation are one decision. Gating the preview more weakly would also make it the cheapest
	 * way in the product to test whether a given number ever called this tenant.
	 */
	@Post("preview")
	@RequirePermissions("recordings.delete")
	async preview(@Session() session: AppSession, @Body() body: unknown) {
		return await this.erasure.preview(session, parseErasureSubject(body));
	}

	/**
	 * Honours the request. Irreversible.
	 *
	 * Returns the same count shape the preview does rather than a `204`, so the caller can show what
	 * actually went beside what was predicted — the two differ legitimately (a call can land between
	 * the two requests) and the difference is the only evidence a compliance record has.
	 */
	@Post()
	@RequirePermissions("recordings.delete")
	async apply(@Session() session: AppSession, @Body() body: unknown) {
		return await this.erasure.apply(session, parseErasureSubject(body));
	}
}
