import { Controller, Get, Inject } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import {
	SoftphoneCredentialsService,
	type SoftphoneCredentialsResponse,
} from "./softphone.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `GET /api/v1/me/softphone` — the caller's own browser softphone credentials.
 *
 * `@RequirePermissions()` (authenticated, no grant) and NOT a `devices.*` permission: this is
 * self-service, and its whole reason for existing is that a user who holds an extension but not
 * `devices.write` can still bring a softphone online. The endpoint resolves the caller's OWN
 * extension from the session — no id is accepted from the client — so the authorization IS the
 * ownership. See `softphone.service.ts`.
 *
 * ## The contract, stated where a client reader lands first
 *
 * Always 200 for an authenticated caller. The body is one of two shapes, discriminated by
 * `configured`:
 *
 * ```
 * { "configured": true,  "extension": {…}, "account": {…}, "transport": {…}, "media": {…} }
 * { "configured": false, "reason": "no-extension" | "no-realm" | "not-provisioned",
 *   "code": "SOFTPHONE_NO_EXTENSION" | …, "message": "…" }
 * ```
 *
 * A client narrows on `configured` and, when it is false, explains `reason` — never the prose.
 * Holding no extension is the ordinary state of an administrator, not a request failure, and this
 * provider is mounted on every authenticated page; answering it 404 wrote a console error onto
 * every screen in the product. `softphone.service.ts` has the full argument. `code` mirrors the
 * status codes this route used to refuse with and is deprecated.
 */
@Controller("api/v1/me/softphone")
export class SoftphoneController {
	constructor(
		@Inject(SoftphoneCredentialsService) private readonly softphone: SoftphoneCredentialsService,
	) {}

	@Get()
	@RequirePermissions()
	async get(@Session() session: AppSession): Promise<SoftphoneCredentialsResponse> {
		return await this.softphone.forSelf(session);
	}
}
