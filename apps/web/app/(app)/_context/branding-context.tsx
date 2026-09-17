"use client";

import { createContext, useContext, type ReactNode } from "react";
import { BrandThemeStyle } from "~/components/ui/brand-theme-style";
import { DEFAULT_BRANDING, type Branding } from "~/lib/branding/contracts";
import { useBranding } from "../_hooks/use-branding-queries";

/**
 * Applies the active organization's white-label branding across the authenticated app.
 *
 * It does two things: it resolves the brand (falling back to the built-in default at every step, so
 * a still-being-built backend or a failed read degrades to the untouched app, never a blank one),
 * and it injects the derived `--role-*` overrides via {@link BrandThemeStyle}. Because the query
 * carries `DEFAULT_BRANDING` as placeholder data, the brand is present from the first paint and a
 * resolved tenant brand replaces it without a flash of the wrong colours.
 *
 * The login page does NOT use this provider — it has no session and no React Query. It resolves
 * branding by HOST, server-side, in the auth layout. Two entry points, one theme layer.
 */

const BrandingContext = createContext<Branding>(DEFAULT_BRANDING);

/** The resolved brand — product name, logo and colours. Never null; defaults to the built-in brand. */
export function useBrand(): Branding {
	return useContext(BrandingContext);
}

export function BrandingProvider({ children }: { children: ReactNode }) {
	const query = useBranding();
	const brand = query.data ?? DEFAULT_BRANDING;

	return (
		<BrandingContext.Provider value={brand}>
			<BrandThemeStyle brand={brand} />
			{children}
		</BrandingContext.Provider>
	);
}
