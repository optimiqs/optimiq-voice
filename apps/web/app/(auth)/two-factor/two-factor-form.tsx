"use client";

import { useForm } from "@tanstack/react-form";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/form-fields";
import { authErrorMessage, twoFactor } from "~/lib/auth-client";
import { routes, safeRedirectTarget } from "~/lib/routes";
import { AuthCard } from "../_components/auth-card";

const totpSchema = z.strictObject({
	code: z
		.string()
		.trim()
		.regex(/^\d{6}$/u, "Enter the 6-digit code from your authenticator app"),
});

const backupSchema = z.strictObject({
	code: z.string().trim().min(1, "Enter one of your backup codes"),
});

/**
 * The second-factor challenge.
 *
 * Reached only from sign-in, which redirects here when better-auth answers with
 * `twoFactorRedirect` — at that point the password was accepted but no session exists yet. A
 * backup code is the way back in for someone who has lost the authenticator, and it is
 * single-use, which is why it is offered as an explicit fallback rather than mixed into one
 * ambiguous input.
 */
export function TwoFactorForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const redirectTo = safeRedirectTarget(searchParams.get("redirectTo"));

	const [useBackupCode, setUseBackupCode] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const schema = useBackupCode ? backupSchema : totpSchema;

	const form = useForm({
		defaultValues: { code: "" },
		validators: { onChange: schema, onSubmit: schema },
		onSubmit: async ({ value }) => {
			const parsed = schema.parse(value);
			setPending(true);
			setFormError(null);
			try {
				const result = useBackupCode
					? await twoFactor.verifyBackupCode({ code: parsed.code })
					: await twoFactor.verifyTotp({ code: parsed.code });
				if (result.error) {
					setFormError(authErrorMessage(result.error));
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
			title="Two-step verification"
			description={
				useBackupCode
					? "Enter one of the backup codes you saved when you turned on two-step verification. Each code works once."
					: "Enter the 6-digit code from your authenticator app."
			}
			footer={
				<Link href={routes.signIn} className="font-medium text-primary hover:underline">
					Sign in with a different account
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

				<form.Field name="code">
					{(field) => (
						<TextField
							field={field}
							label={useBackupCode ? "Backup code" : "Authentication code"}
							autoComplete="one-time-code"
							autoFocus
							required
							disabled={pending}
							className="[&_input]:text-center [&_input]:tracking-[0.35em]"
						/>
					)}
				</form.Field>

				<Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
					Verify
				</Button>

				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => {
						setUseBackupCode((previous) => !previous);
						setFormError(null);
						form.reset();
					}}
				>
					{useBackupCode ? "Use your authenticator app" : "Use a backup code instead"}
				</Button>
			</form>
		</AuthCard>
	);
}
