/**
 * Next configuration.
 *
 * `.mjs`, not `.ts`: Next only loads a TypeScript config when it can resolve a TypeScript
 * installation the way it expects, and in this workspace it cannot — it fails the build outright
 * with "Configuring Next.js via 'next.config.ts' is not supported". oikos-care-web is on `.mjs`
 * for the same reason. The `@type` annotation keeps the object checked in editors.
 */

/**
 * The API origin every `/api/*` request is proxied to.
 *
 * The browser only ever talks to its own origin: `/api/auth/*` and `/api/v1/*` are rewritten to
 * `apps/api` server-side. That keeps the better-auth session cookie first-party — no
 * `SameSite=None`, no CORS preflight, no cross-site cookie blocking — in every environment.
 */
const apiOrigin = (process.env.API_PROXY_ORIGIN ?? "http://127.0.0.1:50051").replace(/\/+$/u, "");

/**
 * The content policy, REPORT-ONLY on purpose.
 *
 * Two of the sources cannot be pinned from this repository: the softphone's WSS listener is
 * whatever `transport.wssUrl` the API reports for the deployment (`lib/softphone/credentials.ts`),
 * and a recording's `play-url` is a signed object-store URL whose host belongs to whatever bucket
 * the deployment configured. Enforcing a policy that guesses at either would break audio in
 * production with a console message nobody reads, so this reports first: run a deployment, read
 * the violations, then narrow `connect-src`/`media-src` to the real hosts and rename the header to
 * `Content-Security-Policy`.
 *
 * `style-src 'unsafe-inline'` is required today by the brand theme's inline `<style>`
 * (`components/ui/brand-theme-style.tsx`); a nonce is the follow-up. `frame-ancestors` supersedes
 * the `X-Frame-Options` above, which stays for browsers that predate it.
 */
const contentSecurityPolicy = [
	"default-src 'self'",
	"base-uri 'self'",
	"object-src 'none'",
	"frame-ancestors 'none'",
	"form-action 'self'",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https:",
	"font-src 'self' data:",
	"media-src 'self' blob: https:",
	"connect-src 'self' blob: https: wss:",
].join("; ");

/** @type {import("next").NextConfig} */
const nextConfig = {
	reactStrictMode: true,
	poweredByHeader: false,
	/**
	 * Emits `.next/standalone` — a self-contained server with only the traced `node_modules` it
	 * actually reaches. This is what `apps/web/Dockerfile` ships: a pnpm workspace install cannot be
	 * copied into a runtime image the way `pnpm deploy --prod` handles the backend services, because
	 * the symlinked store does not survive the copy and Next's server is not a plain library graph.
	 *
	 * Paths inside the output are relative to `outputFileTracingRoot` below, so the entrypoint is
	 * `.next/standalone/apps/web/server.js`, not `.next/standalone/server.js`.
	 */
	output: "standalone",
	outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
	experimental: {
		optimizePackageImports: ["@base-ui/react", "@tanstack/react-query", "@tanstack/react-table"],
	},
	/**
	 * `/provision/*` is proxied alongside `/api/*` because the API hands a PHONE the URL it will
	 * fetch its configuration from, built on `PROVISION_BASE_URL`, and that variable names the
	 * public origin — this one. Without this rewrite the handset fetches the Next app, is redirected
	 * to the sign-in page, and stores an HTML document as its config; the failure is silent on both
	 * sides. The route is public by design (a token in the path is the credential), so no session
	 * cookie is involved.
	 */
	async rewrites() {
		return [
			{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
			{ source: "/provision/:path*", destination: `${apiOrigin}/provision/:path*` },
		];
	},
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
					{ key: "X-Frame-Options", value: "DENY" },
					{
						key: "Strict-Transport-Security",
						value: "max-age=63072000; includeSubDomains",
					},
					{ key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy },
				],
			},
		];
	},
};

export default nextConfig;
