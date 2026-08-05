"use client";

import { useForm } from "@tanstack/react-form";
import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/form-fields";
import { requestPasswordReset } from "~/lib/auth-client";
import { routes } from "~/lib/routes";
import { AuthCard } from "../_components/auth-card";

const forgotPasswordSchema = z.strictObject({ email: z.email("Enter a valid email address") });

/**
 * The confirmation is deliberately identical whether or not the address has an account.
 * Branching on it would turn this form into an account-enumeration oracle — better-auth's own
 * endpoint is careful about that, and the UI must not undo it.
 */
export default function ForgotPasswordPage() {
	const [sentTo, setSentTo] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const form = useForm({
		defaultValues: { email: "" },
		validators: { onChange: forgotPasswordSchema, onSubmit: forgotPasswordSchema },
		onSubmit: async ({ value }) => {
			const parsed = forgotPasswordSchema.parse(value);
			setPending(true);
			try {
				await requestPasswordReset({ email: parsed.email, redirectTo: routes.resetPassword });
				setSentTo(parsed.email);
			} finally {
				setPending(false);
			}
		},
	});

	if (sentTo) {
		return (
			<AuthCard
				title="Check your email"
				description={`If an account exists for ${sentTo}, a password reset link is on its way. The link expires in one hour.`}
				footer={
					<Link href={routes.signIn} className="font-medium text-primary hover:underline">
						Back to sign in
					</Link>
				}
			>
				<Button variant="secondary" className="w-full" onClick={() => setSentTo(null)}>
					Use a different email
				</Button>
			</AuthCard>
		);
	}

	return (
		<AuthCard
			title="Reset your password"
			description="We will email you a link to choose a new one."
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
				<form.Field name="email">
					{(field) => (
						<TextField
							field={field}
							label="Email"
							type="email"
							autoComplete="email"
							required
							disabled={pending}
						/>
					)}
				</form.Field>
				<Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
					Send reset link
				</Button>
			</form>
		</AuthCard>
	);
}
