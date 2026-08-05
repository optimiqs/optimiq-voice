import { Suspense } from "react";
import { LoadingPanel } from "~/components/ui/spinner";
import { AuthCard } from "../_components/auth-card";
import { TwoFactorForm } from "./two-factor-form";

export const metadata = { title: "Two-step verification" };

/**
 * Server shell. The form below reads query parameters, which opts it out of prerendering — the
 * Suspense boundary is what lets the rest of this route stay static instead of pushing the whole
 * page into client-side rendering.
 */
export default function TwoFactorPage() {
	return (
		<Suspense
			fallback={
				<AuthCard title="Two-step verification">
					<LoadingPanel />
				</AuthCard>
			}
		>
			<TwoFactorForm />
		</Suspense>
	);
}
