"use client";

import { useState } from "react";
import { ConfirmDialog } from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName } from "~/components/ui/field";
import { UsersIcon } from "~/components/ui/icons";
import { PageHeader } from "~/components/ui/page-header";
import { LoadingPanel } from "~/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/cn";
import { ASSIGNABLE_ROLE_TEMPLATES, roleLabel } from "~/lib/permissions";
import { RequirePermission } from "../../_components/require-permission";
import { useAppSession, usePermission } from "../../_context/session-context";
import {
	useCancelInvitation,
	useOrganizationInvitations,
	useOrganizationMembers,
	useRemoveMember,
	useUpdateMemberRole,
} from "../../_hooks/use-organization-queries";
import { SettingsNav } from "../_components/settings-nav";
import { InviteMemberDialog } from "./_components/invite-member-dialog";

export default function MembersPage() {
	const session = useAppSession();
	const organizationId = session.activeOrganization?.id;

	const members = useOrganizationMembers(organizationId);
	const invitations = useOrganizationInvitations(organizationId);
	const updateRole = useUpdateMemberRole(organizationId);
	const removeMember = useRemoveMember(organizationId);
	const cancelInvitation = useCancelInvitation(organizationId);

	const canInvite = usePermission("members.invite");
	const canUpdateRole = usePermission("members.update-role");
	const canRemove = usePermission("members.remove");

	const [inviteOpen, setInviteOpen] = useState(false);
	const [pendingRemoval, setPendingRemoval] = useState<{ id: string; name: string } | null>(null);

	const pendingInvitations = (invitations.data ?? []).filter(
		(invitation) => invitation.status === "pending",
	);

	return (
		<>
			<PageHeader
				title="Members"
				description="Who can reach this organization's phone system, and what each of them may do."
				actions={
					canInvite ? (
						<Button variant="primary" onClick={() => setInviteOpen(true)}>
							Invite member
						</Button>
					) : null
				}
			/>
			<SettingsNav />

			<Card>
				<CardHeader>
					<CardTitle>Members</CardTitle>
					<CardDescription>
						A role is a template of permissions, resolved server-side. Changing one takes effect on
						that member&apos;s next request.
					</CardDescription>
				</CardHeader>
				<CardBody className="p-0">
					{members.isPending ? (
						<LoadingPanel label="Loading members" />
					) : members.data && members.data.length > 0 ? (
						<TableContainer className="rounded-none border-0">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Member</TableHead>
										<TableHead>Role</TableHead>
										<TableHead className="w-0" />
									</TableRow>
								</TableHeader>
								<TableBody>
									{members.data.map((member) => {
										const isSelf = member.userId === session.user.id;
										return (
											<TableRow key={member.id}>
												<TableCell>
													<div className="flex flex-col">
														<span className="font-medium">
															{member.name}
															{isSelf ? (
																<span className="ml-2 text-xs text-muted-foreground">You</span>
															) : null}
														</span>
														<span className="text-xs text-muted-foreground">{member.email}</span>
													</div>
												</TableCell>
												<TableCell>
													{canUpdateRole && !isSelf ? (
														<select
															aria-label={`Role for ${member.name}`}
															className={cn(inputClassName, "h-8 w-40 pr-8 text-sm")}
															value={member.role}
															disabled={updateRole.isPending}
															onChange={(event) =>
																updateRole.mutate({
																	memberId: member.id,
																	role: event.target.value,
																})
															}
														>
															{ASSIGNABLE_ROLE_TEMPLATES.map((template) => (
																<option key={template.id} value={template.id}>
																	{template.label}
																</option>
															))}
															{/*
															 * better-auth also stores a bare `member`, which no template
															 * owns. Keeping it selectable would let an edit silently
															 * upgrade or downgrade someone; showing it preserves the
															 * current value without offering it as a choice.
															 */}
															{ASSIGNABLE_ROLE_TEMPLATES.every(
																(template) => template.id !== member.role,
															) ? (
																<option value={member.role} disabled>
																	{member.role}
																</option>
															) : null}
														</select>
													) : (
														<Badge tone={member.role === "owner" ? "accent" : "neutral"}>
															{roleLabel(member.role)}
														</Badge>
													)}
												</TableCell>
												<TableCell className="text-right">
													{canRemove && !isSelf && member.role !== "owner" ? (
														<Button
															size="sm"
															variant="ghost"
															onClick={() =>
																setPendingRemoval({ id: member.id, name: member.name })
															}
														>
															Remove
														</Button>
													) : null}
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</TableContainer>
					) : (
						<EmptyState
							className="rounded-none border-0"
							icon={<UsersIcon className="size-5" />}
							title="No members yet"
							description="Invite the people who will run this phone system."
						/>
					)}
				</CardBody>
			</Card>

			<RequirePermission permissions={["members.invite"]}>
				<Card>
					<CardHeader>
						<CardTitle>Pending invitations</CardTitle>
						<CardDescription>Invitations expire seven days after they are sent.</CardDescription>
					</CardHeader>
					<CardBody className="p-0">
						{invitations.isPending ? (
							<LoadingPanel label="Loading invitations" />
						) : pendingInvitations.length > 0 ? (
							<TableContainer className="rounded-none border-0">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Email</TableHead>
											<TableHead>Role</TableHead>
											<TableHead className="w-0" />
										</TableRow>
									</TableHeader>
									<TableBody>
										{pendingInvitations.map((invitation) => (
											<TableRow key={invitation.id}>
												<TableCell>{invitation.email}</TableCell>
												<TableCell>
													<Badge>{roleLabel(invitation.role)}</Badge>
												</TableCell>
												<TableCell className="text-right">
													<Button
														size="sm"
														variant="ghost"
														loading={cancelInvitation.isPending}
														onClick={() => cancelInvitation.mutate(invitation.id)}
													>
														Revoke
													</Button>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</TableContainer>
						) : (
							<p className="px-6 py-5 text-sm text-muted-foreground">
								No invitations are waiting to be accepted.
							</p>
						)}
					</CardBody>
				</Card>
			</RequirePermission>

			<InviteMemberDialog
				organizationId={organizationId}
				open={inviteOpen}
				onOpenChange={setInviteOpen}
			/>

			<ConfirmDialog
				open={pendingRemoval !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingRemoval(null);
					}
				}}
				title={`Remove ${pendingRemoval?.name ?? "this member"}?`}
				description="They lose access to this organization immediately. Their extension and call history are kept, and they can be invited back."
				confirmLabel="Remove member"
				destructive
				pending={removeMember.isPending}
				onConfirm={() => {
					if (pendingRemoval) {
						removeMember.mutate(pendingRemoval.id, {
							onSettled: () => setPendingRemoval(null),
						});
					}
				}}
			/>
		</>
	);
}
