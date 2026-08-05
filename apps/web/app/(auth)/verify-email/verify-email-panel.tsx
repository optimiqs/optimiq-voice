"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";
import { authErrorMessage, sendVerificationEmail } from "~/lib/auth-client";
import { routes } from "~/lib/routes";
import { AuthCard } from "../_components/auth-card";

/**
 * The waiting room after sign-up.
 *
 * The verification LINK is handled entirely by the server — better-auth's
 * `/api/auth/verify-email` consumes the token and, with `autoSignInAfterVerification`, issues a
 * session before redirecting. This page exists only for the state in between, and to resend.
 *
 * Email delivery is a console stub until SMTP is wired (`auth-email.delivery.ts`), so in
 * development the link is printed in the API log rather than sent.
 */
export function VerifyEmailPanel() {
	const searchParams = useSearchParams();
	const email = searchParams.get("email") ?? "";
	const [pending, setPending] = useState(false);
	const [resent, setResent] = useState(false);

	async function resend() {
		if (!email) {
			return;
		}
		setPending(true);
		try {
			const result = await sendVerificationEmail({ email, callbackURL: routes.overview });
			if (result.error) {
				toast.error(authErrorMessage(result.error));
				return;
			}
			setResent(true);
		} finally {
			setPending(false);
		}
	}

	return (
		<AuthCard
			title="Verify your email"
			description={
				email
					? `We sent a verification link to ${email}. Open it to finish setting up your account.`
					: "Open the verification link we emailed you to finish setting up your account."
			}
			footer={
				<Link href={routes.signIn} className="font-medium text-primary hover:underline">
					Back to sign in
				</Link>
			}
		>
			<div className="flex flex-col gap-3">
				{resent ? (
					<output className="block rounded-field bg-success-subtle px-3 py-2 text-sm text-success">
						Sent. Check your inbox again in a moment.
					</output>
				) : null}
				<Button
					variant="secondary"
					className="w-full"
					loading={pending}
					disabled={!email}
					onClick={() => void resend()}
				>
					Resend verification email
				</Button>
			</div>
		</AuthCard>
	);
}
