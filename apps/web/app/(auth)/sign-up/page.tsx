import { Suspense } from "react";
import { LoadingPanel } from "~/components/ui/spinner";
import { AuthCard } from "../_components/auth-card";
import { SignUpForm } from "./sign-up-form";

export const metadata = { title: "Create your account" };

/**
 * Server shell. The form below reads query parameters, which opts it out of prerendering — the
 * Suspense boundary is what lets the rest of this route stay static instead of pushing the whole
 * page into client-side rendering.
 */
export default function SignUpPage() {
	return (
		<Suspense
			fallback={
				<AuthCard title="Create your account">
					<LoadingPanel />
				</AuthCard>
			}
		>
			<SignUpForm />
		</Suspense>
	);
}
