/**
 * Fax document object keys, and the one seam in this API that downloads a remote URL into the store.
 *
 * There is no prior "fetch a URL into the object store" path anywhere in `apps/api` — recording bytes
 * arrive on the shared Asterisk mount, not over HTTP — so this is written fresh and kept narrow: a
 * single function behind an injected token, so a test drives it without a network.
 */

/** A downloader for inbound fax media. Injected under `FAX_MEDIA_FETCH`. */
export type FaxMediaFetch = (url: string) => Promise<FaxMediaDownload>;

export interface FaxMediaDownload {
	readonly bytes: Buffer;
	/** The carrier's declared content type, when it sent one. */
	readonly contentType: string | undefined;
}

/** The kinds a fax document is stored as. Telnyx renders inbound faxes to PDF or TIFF. */
export const FAX_CONTENT_TYPES = {
	pdf: "application/pdf",
	tiff: "image/tiff",
} as const;

/** The object-store key layout: `faxes/<orgId>/<messageId>.<ext>`. */
export function buildFaxObjectKey(
	organizationId: string,
	messageId: string,
	extension: "pdf" | "tiff",
): string {
	return `faxes/${organizationId}/${messageId}.${extension}`;
}

/** Picks the stored extension from a content type or a URL, defaulting to PDF (Telnyx's default). */
export function faxExtensionFor(
	contentType: string | undefined,
	url: string | undefined,
): "pdf" | "tiff" {
	const type = (contentType ?? "").toLowerCase();
	if (type.includes("tiff") || (url ?? "").toLowerCase().endsWith(".tiff")) {
		return "tiff";
	}
	return "pdf";
}

/**
 * The default downloader: a bounded `fetch` of the carrier URL.
 *
 * Deliberately simple — no retry, because the caller (the inbound webhook path) is itself retried by
 * Telnyx on a non-2xx, and a download that fails leaves the fax row filed without an `object_key`,
 * which is a recoverable state rather than a lost fax.
 */
export function createFaxMediaFetch(fetchImpl: typeof fetch = fetch): FaxMediaFetch {
	return async (url: string): Promise<FaxMediaDownload> => {
		const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) {
			throw new Error(`fax media download failed: ${response.status}`);
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		const contentType = response.headers.get("content-type") ?? undefined;
		return { bytes, contentType };
	};
}
