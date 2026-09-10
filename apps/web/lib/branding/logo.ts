/**
 * The logo upload's client-side rules, and the URL the preview renders.
 *
 * ## Why the checks are duplicated here at all
 *
 * `apps/api`'s `branding-image.ts` is the AUTHORITY: it sniffs magic bytes, so a renamed executable
 * declaring `image/png` is refused there and nowhere else. Nothing below is a security check — a
 * browser cannot make one. What it buys is that choosing a 40 MB video does not spend forty seconds
 * of somebody's upstream before the server says no, and that "this is not an image we store" is
 * said next to the file input instead of arriving as a toast. The cap and the format list are
 * therefore mirrored from the server's constants, and the server's answer still wins on conflict.
 *
 * ## Cache busting is not optional here
 *
 * `GET /api/v1/branding/logo` answers `private, max-age=300` for the session-resolved read. That is
 * correct for a logo, and it means that after an upload the browser would keep showing the OLD
 * image for five minutes — the URL did not change, only the bytes behind it. So every render of the
 * preview and the shell lockup that follows an upload carries a version token, which is the object
 * key the server just returned: it changes exactly when the bytes change, and never otherwise, so a
 * reload with an unchanged logo still hits the cache.
 */

import { brandLogoSrc, type Branding } from "./contracts";

/** Mirrors `BRANDING_LOGO_MAX_UPLOAD_BYTES` in `apps/api/src/pbx/branding-logo/branding-image.ts`. */
export const BRANDING_LOGO_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * The picker's filter. A hint to the file dialog, never a guarantee — both the extension and the
 * declared type are supplied by the client, and the server re-decides from the bytes.
 */
export const BRANDING_LOGO_ACCEPT =
	".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml";

/** The extensions the server's sniffer can end up naming, lower-cased and without the dot. */
const ACCEPTED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "svg"]);

/** The declared types the server's `isPlausibleImageContentType` would let through, narrowed. */
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

/** What the checks need off a `File`, so a spec need not construct one. */
export interface LogoFileFacts {
	readonly name: string;
	readonly size: number;
	readonly type: string;
}

/** A human-readable size, matching the sentence the server's 413 uses (`2 MB`). */
function formatMegabytes(bytes: number): string {
	return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Why this file cannot be a logo, or `undefined` if it may be one.
 *
 * Empty is refused too: the server calls a zero-byte part "the attached file is empty", and a
 * picker can hand one over (a file that was deleted between choosing and submitting).
 */
export function validateLogoFile(file: LogoFileFacts): string | undefined {
	const extension = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
	const declared = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
	// Either signal is enough: several browsers send an empty type for `.svg`, and a file with no
	// extension at all can still carry a correct `image/png`.
	if (!ACCEPTED_EXTENSIONS.has(extension) && !ACCEPTED_TYPES.has(declared)) {
		return "Choose a PNG, JPEG, WebP or SVG image.";
	}
	if (file.size === 0) {
		return "That file is empty.";
	}
	if (file.size > BRANDING_LOGO_MAX_UPLOAD_BYTES) {
		return `That image is ${formatMegabytes(file.size)}. The limit is ${formatMegabytes(
			BRANDING_LOGO_MAX_UPLOAD_BYTES,
		)}.`;
	}
	return undefined;
}

/**
 * The `src` for the logo preview: the brand's logo route, versioned so a fresh upload is shown.
 *
 * `version` is the resolved `logoObjectKey` — a value that already identifies the bytes. An
 * `https:`/`data:` logo is returned exactly as {@link brandLogoSrc} gave it: the token would change
 * a URL somebody else owns, and those two forms carry their own identity already.
 */
export function brandingLogoPreviewSrc(
	brand: Branding,
	version?: string | null,
	host?: string | null,
): string | null {
	const src = brandLogoSrc(brand, host);
	if (src === null || src.startsWith("https:") || src.startsWith("data:")) {
		return src;
	}
	const token = version?.trim();
	if (token === undefined || token.length === 0) {
		return src;
	}
	return `${src}${src.includes("?") ? "&" : "?"}v=${encodeURIComponent(token)}`;
}
