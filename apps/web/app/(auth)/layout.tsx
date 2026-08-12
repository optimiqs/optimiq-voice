import { headers } from "next/headers";
import { BrandThemeStyle } from "~/components/ui/brand-theme-style";
import { fetchBrandingByHost } from "~/lib/branding/client";
import { brandLogoSrc, DEFAULT_BRANDING, type Branding } from "~/lib/branding/contracts";
import type { ReactNode } from "react";

/**
 * One shell for every auth screen. Each page owns only its card, so the landmark, the skip-link
 * target and the centring cannot drift apart the way they do when six routes hand-roll the same
 * wrapper.
 *
 * ## Branding here is resolved by HOST, not by session
 *
 * The login page has no session and no React Query — the authenticated app's `BrandingProvider`
 * cannot run here. So a white-labelled sign-in resolves its brand from the PUBLIC, pre-auth
 * `GET /api/v1/branding/by-host` endpoint, server-side, keyed on the host the request arrived on.
 * The product name, the logo and the `--role-*` theme overrides all come from that read.
 *
 * The read is best-effort: any failure — including the endpoint not existing yet while the W14
 * backend is built — degrades to the built-in brand. A tenant that has not white-labelled, or a
 * backend that has not shipped the endpoint, simply shows "Optimiq Voice". The default is the
 * honest fallback, never a blank page.
 */
async function resolveLoginBranding(): Promise<Branding> {
	try {
		const headerList = await headers();
		const host = headerList.get("host");
		if (!host) {
			return DEFAULT_BRANDING;
		}
		const proto = headerList.get("x-forwarded-proto") ?? "http";
		return await fetchBrandingByHost(host, `${proto}://${host}`);
	} catch {
		return DEFAULT_BRANDING;
	}
}

export default async function AuthLayout({ children }: { children: ReactNode }) {
	const brand = await resolveLoginBranding();
	const logoSrc = brandLogoSrc(brand);

	return (
		<main
			id="main"
			className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 py-12"
		>
			<BrandThemeStyle brand={brand} />
			<div className="mb-8 flex items-center gap-2">
				{logoSrc ? (
					// A tenant logo is an arbitrary URL / data URI, not a candidate for next/image's
					// optimizer allowlist, so it is rendered as a background rather than an <img> (which
					// keeps the surface oxlint-clean and handles data: URIs without remotePatterns config).
					<span
						aria-hidden="true"
						className="size-8 rounded-field bg-contain bg-center bg-no-repeat"
						style={{ backgroundImage: `url(${JSON.stringify(logoSrc)})` }}
					/>
				) : (
					<span
						aria-hidden="true"
						className="flex size-8 items-center justify-center rounded-field bg-primary text-sm font-bold text-primary-foreground"
					>
						{brand.productName.charAt(0).toUpperCase()}
					</span>
				)}
				<span className="text-lg font-semibold tracking-tight text-foreground">
					{brand.productName}
				</span>
			</div>
			{children}
		</main>
	);
}
