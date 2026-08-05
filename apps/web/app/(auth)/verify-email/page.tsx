import { Suspense } from "react";
import { LoadingPanel } from "~/components/ui/spinner";
import { AuthCard } from "../_components/auth-card";
import { VerifyEmailPanel } from "./verify-email-panel";

export const metadata = { title: "Verify your email" };

/**
 * Server shell. The form below reads query parameters, which opts it out of prerendering — the
 * Suspense boundary is what lets the rest of this route stay static instead of pushing the whole
 * page into client-side rendering.
 */
export default function VerifyEmailPage() {
	return (
		<Suspense
			fallback={
				<AuthCard title="Verify your email">
					<LoadingPanel />
				</AuthCard>
			}
		>
			<VerifyEmailPanel />
		</Suspense>
	);
}
