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
import { BrandingLogoUploadService } from "./branding-logo-upload.service";
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
 * ## The honest upstream gap
 *
 * There is no logo UPLOAD path yet — `branding.write` sets the key, and putting the bytes behind it
 * is a follow-up (a multipart upload that namespaces the key under a `branding/` prefix, so a future
 * version can also refuse a key outside that prefix). Until then this serves whatever key the row
 * holds; the object store's own containment check keeps a key from escaping the media root, and a
 * missing object is a clean 404 rather than a broken image.
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

		const stat = await this.store.head(objectKey);
		if (stat === undefined) {
			// The key is set but the object is gone (or never uploaded — see the header's gap note).
			throw new NotFoundException({
				statusCode: 404,
				code: "BRANDING_LOGO_MISSING",
				message: "The configured logo object was not found in the media store.",
			});
		}

		return applyMediaResponse(
			reply,
			await openMediaResponse(this.store, objectKey, stat.sizeBytes, {
				contentType: imageContentType(objectKey),
				fileName: fileNameOf(objectKey),
				disposition: "inline",
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
