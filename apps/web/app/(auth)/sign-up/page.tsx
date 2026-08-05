"use client";

import { useForm } from "@tanstack/react-form";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/form-fields";
import { authErrorMessage, signUp } from "~/lib/auth-client";
import {
	collectFieldErrors,
	focusFirstInvalidField,
	type FieldErrors,
} from "~/lib/forms/field-errors";
import { routes } from "~/lib/routes";
import { AuthCard } from "../_components/auth-card";
import {
	defaultSignUpValues,
	MINIMUM_PASSWORD_LENGTH,
	SIGN_UP_FIELD_ORDER,
	signUpSchema,
	type SignUpField,
} from "./sign-up-schema";

/**
 * The server sets `emailVerification.sendOnSignUp`, and `requireEmailVerification` is on in
 * production only (`apps/api/src/auth/auth.config.ts`). So sign-up may or may not return a
 * session, and the page must handle both: a session means straight into the app, no session means
 * "check your inbox". Assuming either one is how this breaks between environments.
 */
export default function SignUpPage() {
	const router = useRouter();
	const [submitErrors, setSubmitErrors] = useState<FieldErrors<SignUpField>>({});
	const [formError, setFormError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const form = useForm({
		defaultValues: defaultSignUpValues,
		validators: { onChange: signUpSchema, onSubmit: signUpSchema },
		onSubmit: async ({ value }) => {
			const parsed = signUpSchema.parse(value);
			setPending(true);
			setFormError(null);
			try {
				const result = await signUp.email({
					name: parsed.name,
					email: parsed.email,
					password: parsed.password,
				});
				if (result.error) {
					setFormError(authErrorMessage(result.error));
					return;
				}
				router.replace(
					result.data?.token
						? routes.overview
						: `${routes.verifyEmail}?email=${encodeURIComponent(parsed.email)}`,
				);
			} finally {
				setPending(false);
			}
		},
	});

	return (
		<AuthCard
			title="Create your account"
			description="You will set up your organization next."
			footer={
				<>
					Already have an account?{" "}
					<Link href={routes.signIn} className="font-medium text-primary hover:underline">
						Sign in
					</Link>
				</>
			}
		>
			<form
				noValidate
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					const validation = signUpSchema.safeParse(form.store.state.values);
					if (!validation.success) {
						const errors = collectFieldErrors<SignUpField>(validation.error.issues);
						setSubmitErrors(errors);
						focusFirstInvalidField(SIGN_UP_FIELD_ORDER, errors);
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

				<form.Field name="name">
					{(field) => (
						<TextField
							field={field}
							label="Name"
							autoComplete="name"
							required
							disabled={pending}
							submitError={submitErrors.name}
						/>
					)}
				</form.Field>

				<form.Field name="email">
					{(field) => (
						<TextField
							field={field}
							label="Work email"
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
							autoComplete="new-password"
							required
							disabled={pending}
							description={`At least ${MINIMUM_PASSWORD_LENGTH} characters. A passphrase is stronger than a short password with symbols.`}
							submitError={submitErrors.password}
						/>
					)}
				</form.Field>

				<form.Field name="confirmPassword">
					{(field) => (
						<TextField
							field={field}
							label="Confirm password"
							type="password"
							autoComplete="new-password"
							required
							disabled={pending}
							submitError={submitErrors.confirmPassword}
						/>
					)}
				</form.Field>

				<Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
					Create account
				</Button>
			</form>
		</AuthCard>
	);
}
