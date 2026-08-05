"use client";

import { useForm } from "@tanstack/react-form";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/form-fields";
import { authErrorMessage, signIn } from "~/lib/auth-client";
import {
	collectFieldErrors,
	focusFirstInvalidField,
	type FieldErrors,
} from "~/lib/forms/field-errors";
import { routes, safeRedirectTarget } from "~/lib/routes";
import { AuthCard } from "../_components/auth-card";
import {
	defaultSignInValues,
	SIGN_IN_FIELD_ORDER,
	signInSchema,
	type SignInField,
} from "./sign-in-schema";

/**
 * better-auth answers a successful password sign-in for a 2FA-enabled account with
 * `{ twoFactorRedirect: true }` and NO session — the credentials were right, the sign-in is not
 * finished. Treating that as success is the classic way a second factor gets bypassed in the UI,
 * so it routes to the challenge instead.
 */
interface TwoFactorRedirect {
	readonly twoFactorRedirect?: boolean;
}

export function SignInForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const redirectTo = safeRedirectTarget(searchParams.get("redirectTo"));

	const [submitErrors, setSubmitErrors] = useState<FieldErrors<SignInField>>({});
	const [formError, setFormError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const form = useForm({
		defaultValues: defaultSignInValues,
		validators: { onChange: signInSchema, onSubmit: signInSchema },
		onSubmit: async ({ value }) => {
			const parsed = signInSchema.parse(value);
			setPending(true);
			setFormError(null);
			try {
				const result = await signIn.email({ email: parsed.email, password: parsed.password });
				if (result.error) {
					setFormError(authErrorMessage(result.error));
					return;
				}
				const data = result.data as TwoFactorRedirect | null;
				if (data?.twoFactorRedirect) {
					router.replace(`${routes.twoFactor}?redirectTo=${encodeURIComponent(redirectTo)}`);
					return;
				}
				router.replace(redirectTo);
			} finally {
				setPending(false);
			}
		},
	});

	return (
		<AuthCard
			title="Sign in"
			description="Administer your organization's phone system."
			footer={
				<>
					New here?{" "}
					<Link href={routes.signUp} className="font-medium text-primary hover:underline">
						Create an account
					</Link>
				</>
			}
		>
			<form
				noValidate
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					const validation = signInSchema.safeParse(form.store.state.values);
					if (!validation.success) {
						/**
						 * A pristine field never ran the onChange validator, so submitting an empty form
						 * would otherwise move focus to a control showing no reason for the stop.
						 */
						const errors = collectFieldErrors<SignInField>(validation.error.issues);
						setSubmitErrors(errors);
						focusFirstInvalidField(SIGN_IN_FIELD_ORDER, errors);
						return;
					}
					setSubmitErrors({});
					void form.handleSubmit();
				}}
			>
				{formError ? (
					<p role="alert" className="rounded-field bg-danger-subtle px-3 py-2 text-sm text-danger">
						{formError}
					</p>
				) : null}

				<form.Field name="email">
					{(field) => (
						<TextField
							field={field}
							label="Email"
							type="email"
							autoComplete="email"
							required
							disabled={pending}
							submitError={submitErrors.email}
						/>
					)}
				</form.Field>

				<form.Field name="password">
					{(field) => (
						<TextField
							field={field}
							label="Password"
							type="password"
							autoComplete="current-password"
							required
							disabled={pending}
							submitError={submitErrors.password}
						/>
					)}
				</form.Field>

				<div className="flex justify-end">
					<Link
						href={routes.forgotPassword}
						className="text-sm text-muted-foreground hover:text-foreground"
					>
						Forgot password?
					</Link>
				</div>

				<Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
					Sign in
				</Button>
			</form>
		</AuthCard>
	);
}
