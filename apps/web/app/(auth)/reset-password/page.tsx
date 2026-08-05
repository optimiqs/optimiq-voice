import { Suspense } from "react";
import { LoadingPanel } from "~/components/ui/spinner";
import { AuthCard } from "../_components/auth-card";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata = { title: "Reset password" };

/**
 * Server shell. The form below reads query parameters, which opts it out of prerendering — the
 * Suspense boundary is what lets the rest of this route stay static instead of pushing the whole
 * page into client-side rendering.
 */
export default function ResetPasswordPage() {
	return (
		<Suspense
			fallback={
				<AuthCard title="Reset password">
					<LoadingPanel />
				</AuthCard>
			}
		>
			<ResetPasswordForm />
		</Suspense>
	);
}
