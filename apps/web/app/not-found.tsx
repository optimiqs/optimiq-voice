import Link from "next/link";
import { Button } from "~/components/ui/button";
import { routes } from "~/lib/routes";

export default function NotFound() {
	return (
		<main
			id="main"
			className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas px-6 text-center"
		>
			<p className="text-sm font-medium text-muted-foreground">404</p>
			<h1 className="text-2xl font-semibold tracking-tight text-foreground">Page not found</h1>
			<p className="max-w-prose text-sm text-pretty text-muted-foreground">
				The page you were looking for does not exist, or you no longer have access to it.
			</p>
			<Button variant="primary" render={<Link href={routes.overview} />}>
				Back to dashboard
			</Button>
		</main>
	);
}
