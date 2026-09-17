import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { createEntityId } from "@optimiq-voice/identifiers";
import { getLogger } from "@optimiq-voice/logging";
import { BrandingService } from "../../auth/branding/branding.service";
import { OrgLimitsService } from "../org-limits/org-limits.service";
import { PBX_MEDIA_STORE } from "../shared/pbx.tokens";
import { BRANDING_LOGO_MAX_UPLOAD_BYTES, readUploadedImage } from "./branding-image";
import type { EffectiveBranding } from "../../auth/branding/branding.resolver";
import type { ObjectStore } from "../../storage";
import type { MultipartRequest } from "../media/media-upload";
import type { AppSession } from "@optimiq-voice/auth";

const logger = getLogger("api.pbx");

/**
 * The prefix every logo object lives under, so "what is a logo" is answerable by the key alone.
 *
 * The serving route refuses any key outside this prefix (`branding-logo.controller.ts`); storing
 * under it here is the other half of that contract. A
 * key is `branding/<organizationId>/<uuid>.<ext>` — every segment but the extension a UUID this
 * server minted, so `ObjectStore.put`'s containment check has nothing to escape with.
 */
export const BRANDING_LOGO_KEY_PREFIX = "branding";

/**
 * Uploads a white-label logo: sniff the bytes, store them under the tenant's `branding/` namespace,
 * and point the org's branding row at the new key.
 *
 * ## Why this lives in `PbxModule` and not the auth slice
 *
 * The bytes go into `PBX_MEDIA_STORE`, which `PbxModule` owns — the same reason the READ route
 * (`BrandingLogoController`) sits here rather than beside `BrandingController`. The ROW write is the
 * auth slice's `BrandingService.setLogoObjectKey`, reached because `PbxModule` imports `AuthModule`.
 * So the two halves of "a logo arrives" — the object and the row — each stay with the module that
 * owns their storage, and this service is the seam that orders them.
 *
 * ## The object goes first, and the row failing reaps it
 *
 * The bytes are written before the row is updated, for the reason the greeting path sets out: a file
 * with no row is inert and reapable, a row pointing at a missing file serves a broken image. If the
 * row write throws, the object it would have named is unlinked rather than left orphaned. On success,
 * the PREVIOUS own-logo object is reaped best-effort — only when it is genuinely this tenant's own
 * key under this tenant's `branding/` prefix, so a reseller-inherited key is never touched.
 */
@Injectable()
export class BrandingLogoUploadService {
	constructor(
		@Inject(PBX_MEDIA_STORE) private readonly store: ObjectStore,
		@Inject(BrandingService) private readonly branding: BrandingService,
		@Inject(OrgLimitsService) private readonly limits: OrgLimitsService,
	) {}

	async upload(
		session: AppSession,
		request: MultipartRequest,
	): Promise<{ readonly data: EffectiveBranding }> {
		const organizationId = requireActiveOrganizationId(session);
		const image = await readUploadedImage(request, BRANDING_LOGO_MAX_UPLOAD_BYTES);
		// The tenant's storage quota, which nothing consulted before this call site existed. Checked
		// after the bytes are read (the size is not knowable before) and before they are stored.
		await this.limits.assertMayStore(session, image.bytes.byteLength);

		const objectKey = `${BRANDING_LOGO_KEY_PREFIX}/${organizationId}/${createEntityId()}.${image.format.extension}`;
		await this.store.put(objectKey, image.bytes, { contentType: image.format.contentType });

		let result: {
			readonly effective: EffectiveBranding;
			readonly previousObjectKey: string | null;
		};
		try {
			result = await this.branding.setLogoObjectKey(session, objectKey);
		} catch (cause) {
			// The row did not take the new key, so the object it would have named must not survive.
			await this.unlink(objectKey);
			throw cause;
		}

		const previous = result.previousObjectKey;
		if (
			previous !== null &&
			previous !== objectKey &&
			previous.startsWith(`${BRANDING_LOGO_KEY_PREFIX}/${organizationId}/`)
		) {
			await this.unlink(previous);
		}

		return { data: result.effective };
	}

	private async unlink(objectKey: string): Promise<void> {
		await this.store.delete(objectKey).catch((cause: unknown) => {
			logger.error({ objectKey, cause }, "could not unlink a branding logo object");
		});
	}
}
