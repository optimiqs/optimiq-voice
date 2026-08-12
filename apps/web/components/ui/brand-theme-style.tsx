import { brandThemeCss } from "~/lib/branding/theme";
import type { Branding } from "~/lib/branding/contracts";

/**
 * Injects a tenant's brand as `--role-*` overrides.
 *
 * A `<style>` element rather than inline styles on a wrapper, for two reasons: the overrides have to
 * reach both `:root` and `.dark` (which an inline style on one element cannot), and emitting nothing
 * when the brand overrides nothing keeps the default deployment byte-identical. The CSS is built
 * entirely from derived OKLCH numbers in `theme.ts` — never from raw user strings — so there is
 * nothing to escape.
 *
 * Server-safe (no hooks), so the login layout can render it during SSR before any client JS runs,
 * which is what stops a branded login from flashing the default palette first.
 */
export function BrandThemeStyle({ brand }: { brand: Branding }) {
	const css = brandThemeCss(brand);
	if (!css) {
		return null;
	}
	// eslint-disable-next-line react/no-danger -- CSS is derived numbers, not user markup.
	return <style data-brand-theme="" dangerouslySetInnerHTML={{ __html: css }} />;
}
