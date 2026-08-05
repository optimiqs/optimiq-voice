import { ThemeProvider } from "next-themes";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "~/components/ui/toast";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

/**
 * Root layout.
 *
 * Provider order is load-bearing: `ThemeProvider` sets the `.dark` class every token below it
 * reads, `NuqsAdapter` must wrap anything that parses URL state, and `Toaster` is mounted once
 * here so a toast survives a route change.
 *
 * `QueryClientProvider` is deliberately NOT here. Server state only exists for signed-in users,
 * so it belongs to the authenticated group layout — mounting it at the root would keep a cache
 * alive across sign-out and hand the next user the previous one's data.
 */

export const metadata: Metadata = {
	title: { default: "Optimiq Voice", template: "%s · Optimiq Voice" },
	description: "Administration for the Optimiq Voice phone system.",
	applicationName: "Optimiq Voice",
	robots: { index: false, follow: false },
	icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "oklch(0.975 0.003 260)" },
		{ media: "(prefers-color-scheme: dark)", color: "oklch(0.14 0.012 260)" },
	],
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body className="min-h-dvh font-sans antialiased" suppressHydrationWarning>
				<a
					href="#main"
					className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[999] focus:rounded-field focus:bg-foreground focus:px-3 focus:py-2 focus:text-canvas"
				>
					Skip to content
				</a>
				<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
					<NuqsAdapter>
						{children}
						<Toaster />
					</NuqsAdapter>
				</ThemeProvider>
			</body>
		</html>
	);
}
