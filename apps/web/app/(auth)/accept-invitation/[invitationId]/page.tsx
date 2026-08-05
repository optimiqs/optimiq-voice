"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { LoadingPanel } from "~/components/ui/spinner";
import { authClient, authErrorMessage, organization, useSession } from "~/lib/auth-client";
import { roleLabel } from "~/lib/permissions";
import { routes, signInWithRedirect } from "~/lib/routes";
import { AuthCard } from "../../_components/auth-card";

/**
 * The landing page for an organization invitation email.
 *
 * The URL comes from `packages/auth/src/auth.ts`, which builds
 * `${appURL}/accept-invitation/${invitation.id}` — this app's route, not an API endpoint. (The
 * old `GET /api/identity/accept-invite` belonged to the retired identity service and is not the
 * better-auth path.) Acceptance itself is
 * `POST /api/auth/organization/accept-invitation`, called here through the client.
 *
 * The route is public on purpose: the recipient may have no account at all. An unauthenticated
 * visitor is shown what they were invited to and sent to sign-up with a `redirectTo` that brings
 * them straight back here — bouncing them to a bare sign-in screen loses the invitation id and
 * the invitation with it.
 */
export default function AcceptInvitationPage() {
	const router = useRouter();
	const params = useParams<{ invitationId: string }>();
	const invitationId = params.invitationId;
	const { data: session, isPending: sessionPending } = useSession();

	const [invitation, setInvitation] = useState<{
		organizationName: string;
		role: string;
		email: string;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [accepting, setAccepting] = useState(false);

	useEffect(() => {
		let cancelled = false;

		async function load() {
			const result = await authClient.organization.getInvitation({
				query: { id: invitationId },
			});
			if (cancelled) {
				return;
			}
			if (result.error) {
				setError(authErrorMessage(result.error));
			} else if (result.data) {
				setInvitation({
					organizationName: result.data.organizationName,
					role: result.data.role,
					email: result.data.email,
				});
			}
			setLoading(false);
		}

		void load();
		return () => {
			cancelled = true;
		};
	}, [invitationId]);

	async function accept() {
		setAccepting(true);
		setError(null);
		try {
			const result = await organization.acceptInvitation({ invitationId });
			if (result.error) {
				setError(authErrorMessage(result.error));
				return;
			}
			router.replace(routes.overview);
		} finally {
			setAccepting(false);
		}
	}

	if (loading || sessionPending) {
		return (
			<AuthCard title="Checking your invitation">
				<LoadingPanel label="Loading invitation" />
			</AuthCard>
		);
	}

	if (error || !invitation) {
		return (
			<AuthCard
				title="This invitation is not available"
				description={
					error ??
					"It may have expired, been revoked, or already been accepted. Ask an administrator to send a new one."
				}
			>
				<Button variant="secondary" className="w-full" render={<Link href={routes.signIn} />}>
					Go to sign in
				</Button>
			</AuthCard>
		);
	}

	if (!session) {
		const back = routes.acceptInvitation(invitationId);
		return (
			<AuthCard
				title={`Join ${invitation.organizationName}`}
				description={`You have been invited as ${roleLabel(invitation.role)}. Sign in as ${invitation.email}, or create an account with that address, to accept.`}
			>
				<div className="flex flex-col gap-2">
					<Button
						variant="primary"
						className="w-full"
						render={<Link href={`${routes.signUp}?redirectTo=${encodeURIComponent(back)}`} />}
					>
						Create an account
					</Button>
					<Button
						variant="secondary"
						className="w-full"
						render={<Link href={signInWithRedirect(back)} />}
					>
						I already have an account
					</Button>
				</div>
			</AuthCard>
		);
	}

	const emailMatches = session.user.email.toLowerCase() === invitation.email.toLowerCase();

	return (
		<AuthCard
			title={`Join ${invitation.organizationName}`}
			description={`You have been invited as ${roleLabel(invitation.role)}.`}
		>
			<div className="flex flex-col gap-3">
				{emailMatches ? null : (
					<p
						role="alert"
						className="rounded-field bg-warning-subtle px-3 py-2 text-sm text-warning"
					>
						This invitation was sent to {invitation.email}, but you are signed in as{" "}
						{session.user.email}. Accepting will add the invitation to the account you are signed in
						as, if the server allows it.
					</p>
				)}
				<Button
					variant="primary"
					className="w-full"
					loading={accepting}
					onClick={() => void accept()}
				>
					Accept invitation
				</Button>
				<Button variant="ghost" className="w-full" render={<Link href={routes.overview} />}>
					Not now
				</Button>
			</div>
		</AuthCard>
	);
}
