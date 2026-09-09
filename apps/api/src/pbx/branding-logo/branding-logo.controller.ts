import {
	Controller,
	Get,
	Header,
	HttpCode,
	HttpStatus,
	Inject,
	NotFoundException,
	Post,
	Query,
	Req,
	Res,
} from "@nestjs/common";
import { z } from "zod/v4";
import { BrandingService } from "../../auth/branding/branding.service";
import { PublicRoute } from "../../auth/public-route.decorator";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import {
	applyMediaResponse,
	type MediaReply,
	type MediaRequest,
	readRangeHeader,
} from "../../media/media-http";
import { openMediaResponse } from "../../media/media-response";
import { parseDto } from "../shared/dto";
import { PBX_MEDIA_STORE } from "../shared/pbx.tokens";
import {
	BrandingLogoUploadService,
	BRANDING_LOGO_KEY_PREFIX,
} from "./branding-logo-upload.service";
import type { ObjectStore } from "../../storage";
import type { MultipartRequest } from "../media/media-upload";
import type { AppSession } from "@optimiq-voice/auth";

const logoQuery = z.object({ host: z.string().trim().min(1).max(253) });

/**
 * `GET /api/v1/branding/logo` — the bytes of a white-label logo, keyed by request host.
 *
 * ## Why this route exists and why it is public
 *
 * The branding cascade stores a logo as an OBJECT KEY (`branding.logoObjectKey`), not a URL and not
 * bytes — the read endpoints return the key, and something has to turn it into an image the login
 * page can render before anyone signs in. That is this route: `@PublicRoute()` and host-keyed,
 * exactly like `GET /api/v1/branding/by-host`, because the browser that fetches a login page's
 * `<img src>` has no session. The host is resolved to a branding row server-side and the object key
 * comes from THAT row, never from the client — so a public caller cannot name an arbitrary object,
 * only the logo the host's tenant configured.
 *
 * ## Why it lives in `PbxModule` and not the auth slice
 *
 * The bytes live in the media object store (`PBX_MEDIA_STORE`), which `PbxModule` owns; the auth
 * slice has no object store and cannot take one without a module cycle. So the route sits here and
 * reaches the branding cascade through the exported `BrandingService`, the same split the reseller
 * telephony-usage route makes.
 *
 * ## Why the key is prefix-bound on READ and not only on write
 *
 * `PATCH /api/v1/branding` still accepts a `logoObjectKey` string, so an ordinary tenant admin can
 * put ANY key in that column — and this route is public and range-capable over `PBX_MEDIA_STORE`,
 * the single object root that also holds every tenant's call recordings, voicemail messages,
 * prompts and greetings. `resolveObjectPath` proves containment inside that root and nothing more.
 * So the namespace is enforced here, on the read: a key outside `branding/` is a 404, whatever the
 * row says. `BrandingLogoUploadService` mints keys inside the prefix, so a logo that was uploaded
 * rather than typed in is unaffected.
 *
 * ## Why an SVG logo is a download
 *
 * This is a plain, public, GET-navigable URL. `image/svg+xml` served `inline` renders as a
 * DOCUMENT when navigated to, and script inside it executes on the API origin — the origin the
 * session cookie is scoped to. The `<img src>` the login page uses does not execute it either way,
 * so `attachment` costs the real consumer nothing. `nosniff` and a `default-src 'none'` CSP ride
 * along on every logo response as the second layer.
 */
@Controller("api/v1/branding")
export class BrandingLogoController {
	constructor(
		@Inject(BrandingService) private readonly branding: BrandingService,
		@Inject(PBX_MEDIA_STORE) private readonly store: ObjectStore,
		@Inject(BrandingLogoUploadService) private readonly uploads: BrandingLogoUploadService,
	) {}

	/**
	 * `POST /api/v1/branding/logo` — stores an uploaded logo and points the tenant's brand at it.
	 *
	 * `branding.write` gated (a logo is presentation configuration, the same permission the branding
	 * PATCH takes), multipart, and it returns the re-resolved effective branding so the caller sees
	 * the key it now holds. The bytes are sniffed by magic bytes and namespaced under `branding/`;
	 * see `branding-image.ts` and `branding-logo-upload.service.ts`.
	 */
	@Post("logo")
	@HttpCode(HttpStatus.OK)
	@RequirePermissions("branding.write")
	async upload(@Session() session: AppSession, @Req() request: MultipartRequest) {
		return await this.uploads.upload(session, request);
	}

	@Get("logo")
	@PublicRoute()
	@Header("Cache-Control", "public, max-age=300")
	@Header("X-Content-Type-Options", "nosniff")
	@Header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	async logo(
		@Query() query: unknown,
		@Req() request: MediaRequest,
		@Res({ passthrough: true }) reply: MediaReply,
	) {
		const { host } = parseDto(logoQuery, query ?? {});
		const branding = await this.branding.readByHost(host);
		const objectKey = branding.logoObjectKey;
		if (objectKey === null || objectKey.length === 0) {
			throw new NotFoundException({
				statusCode: 404,
				code: "BRANDING_NO_LOGO",
				message: "This host has no white-label logo configured.",
			});
		}
		if (!objectKey.startsWith(`${BRANDING_LOGO_KEY_PREFIX}/`)) {
			// Not "forbidden": the caller is anonymous and the key came off a row they cannot see, so
			// the honest answer is that this host has no logo this route will serve.
			throw new NotFoundException({
				statusCode: 404,
				code: "BRANDING_NO_LOGO",
				message: "This host has no white-label logo configured.",
			});
		}

		const stat = await this.store.head(objectKey);
		if (stat === undefined) {
			// The key is set but the object is gone (or never uploaded — see the header's gap note).
			throw new NotFoundException({
				statusCode: 404,
				code: "BRANDING_LOGO_MISSING",
				message: "The configured logo object was not found in the media store.",
			});
		}

		const contentType = imageContentType(objectKey);
		return applyMediaResponse(
			reply,
			await openMediaResponse(this.store, objectKey, stat.sizeBytes, {
				contentType,
				fileName: fileNameOf(objectKey),
				disposition: contentType === "image/svg+xml" ? "attachment" : "inline",
				rangeHeader: readRangeHeader(request),
			}),
		);
	}
}

/** Content type from the object key's extension. Defaults to PNG, the common logo format. */
function imageContentType(objectKey: string): string {
	const lower = objectKey.toLowerCase();
	if (lower.endsWith(".svg")) {
		return "image/svg+xml";
	}
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
		return "image/jpeg";
	}
	if (lower.endsWith(".webp")) {
		return "image/webp";
	}
	if (lower.endsWith(".gif")) {
		return "image/gif";
	}
	return "image/png";
}

/** The trailing path segment, so a save-as gets a sensible name rather than the whole key. */
function fileNameOf(objectKey: string): string {
	const segment = objectKey.slice(objectKey.lastIndexOf("/") + 1);
	return segment.length > 0 ? segment : "logo";
}
