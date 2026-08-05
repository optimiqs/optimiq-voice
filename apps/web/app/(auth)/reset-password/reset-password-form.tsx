"use client";

import { useForm } from "@tanstack/react-form";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/form-fields";
import { authErrorMessage, resetPassword } from "~/lib/auth-client";
import { routes } from "~/lib/routes";
import { AuthCard } from "../_components/auth-card";
import { MINIMUM_PASSWORD_LENGTH } from "../sign-up/sign-up-schema";

const resetPasswordSchema = z
	.strictObject({
		password: z
			.string()
			.min(MINIMUM_PASSWORD_LENGTH, `Use at least ${MINIMUM_PASSWORD_LENGTH} characters`),
		confirmPassword: z.string().min(1, "Confirm your password"),
	})
	.refine((values) => values.password === values.confirmPassword, {
		message: "Passwords do not match",
		path: ["confirmPassword"],
	});

/**
 * better-auth puts the reset token in the `token` query parameter of the link it emails. Without
 * one there is nothing to submit against, so the page says so rather than rendering a form whose
 * submit can only fail.
 */
export function ResetPasswordForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const token = searchParams.get("token");

	const [formError, setFormError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const form = useForm({
		defaultValues: { password: "", confirmPassword: "" },
		validators: { onChange: resetPasswordSchema, onSubmit: resetPasswordSchema },
		onSubmit: async ({ value }) => {
			if (!token) {
				return;
			}
			const parsed = resetPasswordSchema.parse(value);
			setPending(true);
			setFormError(null);
			try {
				const result = await resetPassword({ newPassword: parsed.password, token });
				if (result.error) {
					setFormError(authErrorMessage(result.error));
					return;
				}
				router.replace(`${routes.signIn}?reset=1`);
			} finally {
				setPending(false);
			}
		},
	});

	if (!token) {
		return (
			<AuthCard
				title="This link is not valid"
				description="Password reset links expire after an hour and can only be used once. Request a new one to continue."
			>
				<Button variant="primary" className="w-full" render={<Link href={routes.forgotPassword} />}>
					Request a new link
				</Button>
			</AuthCard>
		);
	}

	return (
		<AuthCard
			title="Choose a new password"
			description="You will be signed out of other sessions."
			footer={
				<Link href={routes.signIn} className="font-medium text-primary hover:underline">
					Back to sign in
				</Link>
			}
		>
			<form
				noValidate
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					void form.handleSubmit();
				}}
			>
				{formError ? (
					<p role="alert" className="rounded-field bg-danger-subtle px-3 py-2 text-sm text-danger">
						{formError}
					</p>
				) : null}

				<form.Field name="password">
					{(field) => (
						<TextField
							field={field}
							label="New password"
							type="password"
							autoComplete="new-password"
							required
							disabled={pending}
							description={`At least ${MINIMUM_PASSWORD_LENGTH} characters.`}
						/>
					)}
				</form.Field>

				<form.Field name="confirmPassword">
					{(field) => (
						<TextField
							field={field}
							label="Confirm new password"
							type="password"
							autoComplete="new-password"
							required
							disabled={pending}
						/>
					)}
				</form.Field>

				<Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
					Update password
				</Button>
			</form>
		</AuthCard>
	);
}
