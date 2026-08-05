import { Suspense } from "react";
import { LoadingPanel } from "~/components/ui/spinner";
import { AuthCard } from "../_components/auth-card";
import { SignInForm } from "./sign-in-form";

export const metadata = { title: "Sign in" };

/**
 * Server shell. The form below reads query parameters, which opts it out of prerendering — the
 * Suspense boundary is what lets the rest of this route stay static instead of pushing the whole
 * page into client-side rendering.
 */
export default function SignInPage() {
	return (
		<Suspense
			fallback={
				<AuthCard title="Sign in">
					<LoadingPanel />
				</AuthCard>
			}
		>
			<SignInForm />
		</Suspense>
	);
}
