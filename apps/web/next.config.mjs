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
	async rewrites() {
		return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
	},
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
					{ key: "X-Frame-Options", value: "DENY" },
				],
			},
		];
	},
};

export default nextConfig;
