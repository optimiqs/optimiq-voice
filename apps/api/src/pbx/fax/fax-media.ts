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
 * The ceiling on a downloaded fax document.
 *
 * A fax is a handful of pages; fifty megabytes is far past anything a real one reaches. The cap
 * exists because the URL comes out of a webhook body — the signature authenticates the WEBHOOK, not
 * the arbitrary URL inside it — so a carrier-side bug or a redirect could otherwise hand this
 * process a multi-gigabyte body and take the whole control plane down with it, every tenant, not
 * just fax.
 */
const MAX_FAX_MEDIA_BYTES = 50 * 1024 * 1024;

/**
 * The default downloader: a `fetch` of the carrier URL, bounded in time AND in bytes.
 *
 * Deliberately simple — no retry, because the caller (the inbound webhook path) is itself retried by
 * Telnyx on a non-2xx, and a download that fails leaves the fax row filed without an `object_key`,
 * which is a recoverable state rather than a lost fax. The cap is enforced twice: on the declared
 * `content-length`, which refuses before a byte is read, and while reading, because a body can
 * declare nothing or lie.
 */
export function createFaxMediaFetch(fetchImpl: typeof fetch = fetch): FaxMediaFetch {
	return async (url: string): Promise<FaxMediaDownload> => {
		const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) {
			throw new Error(`fax media download failed: ${response.status}`);
		}
		const declared = Number(response.headers.get("content-length") ?? Number.NaN);
		if (Number.isFinite(declared) && declared > MAX_FAX_MEDIA_BYTES) {
			throw new Error(`fax media download too large: ${declared} bytes`);
		}
		const bytes = await readCapped(response, MAX_FAX_MEDIA_BYTES);
		const contentType = response.headers.get("content-type") ?? undefined;
		return { bytes, contentType };
	};
}

/** Reads the body, giving up the moment it goes past `limit` rather than after. */
async function readCapped(response: Response, limit: number): Promise<Buffer> {
	const body = response.body;
	if (body === null) {
		return Buffer.alloc(0);
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > limit) {
				throw new Error(`fax media download too large: over ${limit} bytes`);
			}
			chunks.push(value);
		}
	} finally {
		// Releases the socket on the throw path as well; an abandoned reader would otherwise keep the
		// connection and its buffers alive.
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks, total);
}
