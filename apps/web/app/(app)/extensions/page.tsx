import { ExtensionsScreen } from "./_components/extensions-screen";

export const metadata = { title: "Extensions" };

/**
 * The route is a server component that renders one client screen.
 *
 * `metadata` can only be exported from a server component, and the screen below it needs hooks —
 * so the page stays a two-line shell rather than becoming a client component with a hand-written
 * `<title>`.
 */
export default function ExtensionsPage() {
	return <ExtensionsScreen />;
}
