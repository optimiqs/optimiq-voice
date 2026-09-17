import { Readable } from "node:stream";
import { expect } from "chai";
import {
	BRANDING_LOGO_MAX_UPLOAD_BYTES,
	probeImage,
	readUploadedImage,
} from "../../src/pbx/branding-logo/branding-image";
import {
	BRANDING_LOGO_KEY_PREFIX,
	BrandingLogoUploadService,
} from "../../src/pbx/branding-logo/branding-logo-upload.service";
import { BrandingLogoController } from "../../src/pbx/branding-logo/branding-logo.controller";
import type { BrandingService } from "../../src/auth/branding/branding.service";
import type { MediaReply } from "../../src/media/media-http";
import type { MultipartRequest } from "../../src/pbx/media/media-upload";
import type { OrgLimitsService } from "../../src/pbx/org-limits/org-limits.service";
import type { ObjectStore } from "../../src/storage";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * White-label logo upload, api-side.
 *
 * Two layers: the magic-byte sniffer as a pure function and the multipart reader against a fake
 * request, then the upload service against a fake store and a fake branding row so the object key
 * layout, the row write and the reap of the replaced object are all asserted without a database.
 */

const ORG = "11111111-1111-4111-8111-111111111111";

function sessionFor(organizationId: string | null): AppSession {
	return {
		session: {
			id: "sess",
			userId: "22222222-2222-4222-8222-222222222222",
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: organizationId,
		},
		user: { id: "u", email: "u@test", name: "U", emailVerified: true },
	} as AppSession;
}

// Minimal but honest magic-byte heads for each accepted format.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = Buffer.concat([
	Buffer.from("RIFF", "latin1"),
	Buffer.from([0x00, 0x00, 0x00, 0x00]),
	Buffer.from("WEBP", "latin1"),
	Buffer.from("VP8 ", "latin1"),
]);
const SVG = Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>`);
const WAV = Buffer.concat([
	Buffer.from("RIFF", "latin1"),
	Buffer.from([0x00, 0x00, 0x00, 0x00]),
	Buffer.from("WAVE", "latin1"),
]);

describe("branding logo magic-byte sniffer", () => {
	it("recognises PNG, JPEG, WebP and SVG", () => {
		expect(probeImage(PNG)?.kind).to.equal("png");
		expect(probeImage(JPEG)?.kind).to.equal("jpeg");
		expect(probeImage(WEBP)?.kind).to.equal("webp");
		expect(probeImage(SVG)?.kind).to.equal("svg");
	});

	it("maps each format to its stored extension and served content type", () => {
		expect(probeImage(PNG)).to.deep.equal({
			kind: "png",
			extension: "png",
			contentType: "image/png",
		});
		expect(probeImage(JPEG)?.extension).to.equal("jpg");
		expect(probeImage(WEBP)?.contentType).to.equal("image/webp");
		expect(probeImage(SVG)?.contentType).to.equal("image/svg+xml");
	});

	it("refuses a RIFF container that is not WebP (a WAV shares the RIFF prefix)", () => {
		// The WebP check reads the form type at offset 8, so a RIFF/WAVE header is not mistaken for it.
		expect(probeImage(WAV)).to.equal(undefined);
	});

	it("refuses arbitrary non-image bytes", () => {
		expect(probeImage(Buffer.from("not an image at all"))).to.equal(undefined);
		expect(probeImage(Buffer.from([0x1f, 0x8b, 0x08]))).to.equal(undefined); // gzip
	});

	it("does not mistake plain text or HTML for SVG", () => {
		expect(probeImage(Buffer.from("<html><body>hi</body></html>"))).to.equal(undefined);
		expect(probeImage(Buffer.from("hello <svg> not at the front and not a tag start"))).to.equal(
			undefined,
		);
	});
});

/** A one-file multipart request over the given parts. */
function multipart(
	files: readonly {
		readonly bytes: Buffer;
		readonly filename?: string;
		readonly mimetype?: string;
	}[],
): MultipartRequest {
	return {
		isMultipart: () => true,
		parts: async function* () {
			for (const file of files) {
				yield {
					type: "file" as const,
					fieldname: "file",
					filename: file.filename,
					mimetype: file.mimetype,
					file: (async function* () {
						yield file.bytes;
					})(),
				};
			}
		},
	} as unknown as MultipartRequest;
}

describe("branding logo multipart reader", () => {
	it("accepts a PNG and reports its format and name", async () => {
		const image = await readUploadedImage(
			multipart([{ bytes: PNG, filename: "brand.png", mimetype: "image/png" }]),
			BRANDING_LOGO_MAX_UPLOAD_BYTES,
		);
		expect(image.format.extension).to.equal("png");
		expect(image.fileName).to.equal("brand.png");
		expect(image.sizeBytes).to.equal(PNG.length);
	});

	it("refuses bytes that are not an image we store, by magic bytes not by name", async () => {
		// Named .png, declared image/png, but the bytes are a WAV — the sniffer is the rule.
		let rejected = false;
		try {
			await readUploadedImage(
				multipart([{ bytes: WAV, filename: "brand.png", mimetype: "image/png" }]),
				BRANDING_LOGO_MAX_UPLOAD_BYTES,
			);
		} catch (error) {
			rejected = true;
			expect((error as { getStatus?: () => number }).getStatus?.()).to.equal(400);
		}
		expect(rejected).to.equal(true);
	});

	it("refuses a part that affirmatively declares a non-image type", async () => {
		let rejected = false;
		try {
			await readUploadedImage(
				multipart([{ bytes: PNG, filename: "brand.png", mimetype: "application/zip" }]),
				BRANDING_LOGO_MAX_UPLOAD_BYTES,
			);
		} catch {
			rejected = true;
		}
		expect(rejected).to.equal(true);
	});

	it("enforces the size cap and reports it as too large", async () => {
		const big = Buffer.concat([PNG, Buffer.alloc(64)]);
		let status: number | undefined;
		try {
			await readUploadedImage(multipart([{ bytes: big, mimetype: "image/png" }]), PNG.length);
		} catch (error) {
			status = (error as { getStatus?: () => number }).getStatus?.();
		}
		expect(status).to.equal(413);
	});

	it("refuses a second file rather than silently dropping it", async () => {
		let rejected = false;
		try {
			await readUploadedImage(
				multipart([
					{ bytes: PNG, mimetype: "image/png" },
					{ bytes: JPEG, mimetype: "image/jpeg" },
				]),
				BRANDING_LOGO_MAX_UPLOAD_BYTES,
			);
		} catch {
			rejected = true;
		}
		expect(rejected).to.equal(true);
	});

	it("refuses an empty upload", async () => {
		let rejected = false;
		try {
			await readUploadedImage(multipart([]), BRANDING_LOGO_MAX_UPLOAD_BYTES);
		} catch {
			rejected = true;
		}
		expect(rejected).to.equal(true);
	});
});

/** A store that records what it put and deleted, and can be told to fail on put. */
function fakeStore(): ObjectStore & { readonly puts: string[]; readonly deletes: string[] } {
	const puts: string[] = [];
	const deletes: string[] = [];
	return {
		driver: "local",
		puts,
		deletes,
		put: async (objectKey: string) => {
			puts.push(objectKey);
			await Promise.resolve();
		},
		delete: async (objectKey: string) => {
			deletes.push(objectKey);
			await Promise.resolve();
		},
	} as unknown as ObjectStore & { readonly puts: string[]; readonly deletes: string[] };
}

/** A branding service that records the key it was asked to set and returns a previous own-key. */
function fakeBranding(
	previousObjectKey: string | null,
	options: { readonly throws?: boolean } = {},
): BrandingService & { readonly setKeys: string[] } {
	const setKeys: string[] = [];
	return {
		setKeys,
		setLogoObjectKey: async (_session: AppSession, objectKey: string) => {
			setKeys.push(objectKey);
			if (options.throws) {
				throw new Error("row write failed");
			}
			return {
				effective: { productName: "Acme", logoObjectKey: objectKey } as never,
				previousObjectKey,
			};
		},
	} as unknown as BrandingService & { readonly setKeys: string[] };
}

/** An org-limits gate that either allows everything or refuses, recording what it was asked. */
function fakeLimits(
	options: { readonly refuse?: boolean } = {},
): OrgLimitsService & { readonly asked: number[] } {
	const asked: number[] = [];
	return {
		asked,
		assertMayStore: async (_session: AppSession, incomingBytes: number) => {
			asked.push(incomingBytes);
			await Promise.resolve();
			if (options.refuse === true) {
				throw new Error("over quota");
			}
		},
	} as unknown as OrgLimitsService & { readonly asked: number[] };
}

describe("branding logo upload service", () => {
	it("namespaces the key under branding/<org>/ and writes it onto the row", async () => {
		const store = fakeStore();
		const branding = fakeBranding(null);
		const service = new BrandingLogoUploadService(store, branding, fakeLimits());

		const result = await service.upload(
			sessionFor(ORG),
			multipart([{ bytes: PNG, filename: "logo.png", mimetype: "image/png" }]),
		);

		expect(store.puts).to.have.length(1);
		const key = store.puts[0] ?? "";
		expect(key.startsWith(`${BRANDING_LOGO_KEY_PREFIX}/${ORG}/`)).to.equal(true);
		expect(key.endsWith(".png")).to.equal(true);
		// The same key is what the row was pointed at, and the effective branding is returned.
		expect(branding.setKeys).to.deep.equal([key]);
		expect(result.data.logoObjectKey).to.equal(key);
	});

	it("reaps the previous own logo object, but only under this tenant's branding/ prefix", async () => {
		const previous = `${BRANDING_LOGO_KEY_PREFIX}/${ORG}/00000000-0000-4000-8000-000000000000.png`;
		const store = fakeStore();
		const service = new BrandingLogoUploadService(store, fakeBranding(previous), fakeLimits());
		await service.upload(sessionFor(ORG), multipart([{ bytes: JPEG, mimetype: "image/jpeg" }]));
		expect(store.deletes).to.deep.equal([previous]);
	});

	it("never reaps a reseller-inherited key (outside this tenant's prefix)", async () => {
		const inherited = `${BRANDING_LOGO_KEY_PREFIX}/99999999-9999-4999-8999-999999999999/x.png`;
		const store = fakeStore();
		const service = new BrandingLogoUploadService(store, fakeBranding(inherited), fakeLimits());
		await service.upload(sessionFor(ORG), multipart([{ bytes: PNG, mimetype: "image/png" }]));
		expect(store.deletes).to.deep.equal([]);
	});

	it("unlinks the just-stored object when the row write fails, leaving no orphan", async () => {
		const store = fakeStore();
		const service = new BrandingLogoUploadService(
			store,
			fakeBranding(null, { throws: true }),
			fakeLimits(),
		);
		let threw = false;
		try {
			await service.upload(sessionFor(ORG), multipart([{ bytes: PNG, mimetype: "image/png" }]));
		} catch {
			threw = true;
		}
		expect(threw).to.equal(true);
		expect(store.puts).to.have.length(1);
		expect(store.deletes).to.deep.equal([store.puts[0]]);
	});

	it("refuses an upload the storage quota does not allow, before anything is stored", async () => {
		const store = fakeStore();
		const branding = fakeBranding(null);
		const limits = fakeLimits({ refuse: true });
		const service = new BrandingLogoUploadService(store, branding, limits);

		let threw = false;
		try {
			await service.upload(sessionFor(ORG), multipart([{ bytes: PNG, mimetype: "image/png" }]));
		} catch {
			threw = true;
		}

		expect(threw).to.equal(true);
		expect(limits.asked).to.deep.equal([PNG.byteLength]);
		// Nothing reached the store and nothing reached the row: the gate is in front of both.
		expect(store.puts).to.deep.equal([]);
		expect(branding.setKeys).to.deep.equal([]);
	});
});

/**
 * The READ route's tenant resolution.
 *
 * `readByHost` goes through `organization_branding.custom_domain`, so it can only ever answer for a
 * tenant that has its own login host. Before the `host` parameter became optional, that was the
 * ONLY way to reach the bytes — which meant every tenant on the shared platform host could upload a
 * logo, see the key land on its row, and have nothing in the product able to render it. These pin
 * the two resolutions apart, and the cache directive that has to follow them.
 */
describe("branding logo read: which tenant answers", () => {
	interface Recorded {
		readonly headers: Record<string, string>;
		readonly status: number | null;
	}

	function fakeReply(): MediaReply & { readonly recorded: Recorded } {
		const headers: Record<string, string> = {};
		const recorded: Recorded = { headers, status: null };
		return {
			recorded,
			header(name: string, value: string) {
				headers[name.toLowerCase()] = value;
				return this;
			},
			status(code: number) {
				(recorded as { status: number | null }).status = code;
				return this;
			},
		};
	}

	const LOGO_KEY = `${BRANDING_LOGO_KEY_PREFIX}/${ORG}/logo.png`;

	function controller(options: {
		readonly byHost?: string | null;
		readonly byOrganization?: string | null;
	}) {
		const asked: string[] = [];
		const branding = {
			async readByHost(host: string) {
				asked.push(`host:${host}`);
				return { logoObjectKey: options.byHost ?? null };
			},
			async resolveForOrganization(organizationId: string) {
				asked.push(`org:${organizationId}`);
				return { logoObjectKey: options.byOrganization ?? null };
			},
		} as unknown as BrandingService;
		const store = {
			async head() {
				return { sizeBytes: PNG.byteLength };
			},
			async getStream() {
				return Readable.from([PNG]);
			},
		} as unknown as ObjectStore;
		const instance = new BrandingLogoController(branding, store, {} as BrandingLogoUploadService);
		return { instance, asked };
	}

	it("resolves by host when one is named, and lets a shared cache keep that answer", async () => {
		const { instance, asked } = controller({ byHost: LOGO_KEY });
		const reply = fakeReply();
		await instance.logo({ host: "acme.example" }, null, {}, reply);
		expect(asked).to.deep.equal(["host:acme.example"]);
		expect(reply.recorded.headers["cache-control"]).to.equal("public, max-age=300");
	});

	it("resolves the acting organization when no host is named, and keeps that answer private", async () => {
		const { instance, asked } = controller({ byOrganization: LOGO_KEY });
		const reply = fakeReply();
		await instance.logo({}, sessionFor(ORG), {}, reply);
		expect(asked).to.deep.equal([`org:${ORG}`]);
		// A shared cache must never hand one tenant's logo to the next caller of this same URL.
		expect(reply.recorded.headers["cache-control"]).to.equal("private, max-age=300");
	});

	it("prefers the named host even when the caller also has a session", async () => {
		const { instance, asked } = controller({ byHost: LOGO_KEY, byOrganization: LOGO_KEY });
		await instance.logo({ host: "acme.example" }, sessionFor(ORG), {}, fakeReply());
		expect(asked).to.deep.equal(["host:acme.example"]);
	});

	it("refuses a caller that names neither a host nor an organization", async () => {
		const { instance, asked } = controller({});
		let status: number | undefined;
		try {
			await instance.logo({}, sessionFor(null), {}, fakeReply());
		} catch (error) {
			status = (error as { getStatus?: () => number }).getStatus?.();
		}
		expect(status).to.equal(400);
		// Nothing was resolved: an unresolvable request must not fall back to the platform default.
		expect(asked).to.deep.equal([]);
	});

	it("still refuses a key outside the branding prefix, on the session path too", async () => {
		const { instance } = controller({ byOrganization: "recordings/other-org/secret.wav" });
		let status: number | undefined;
		try {
			await instance.logo({}, sessionFor(ORG), {}, fakeReply());
		} catch (error) {
			status = (error as { getStatus?: () => number }).getStatus?.();
		}
		expect(status).to.equal(404);
	});
});
