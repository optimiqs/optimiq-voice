"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { inputClassName } from "~/components/ui/field";
import { apiFetch } from "~/lib/api-client";
import { queryKeys } from "~/lib/query-keys";
import { useAppSession } from "../../_context/session-context";
import { useOrganizationMembers } from "../../_hooks/use-organization-queries";
import type { ExtensionRow } from "~/lib/pbx/contracts";

interface Assignment {
	id: string;
	userId: string;
	role: "primary" | "shared" | "delegate";
}

export function ExtensionUsersDialog({
	extension,
	onClose,
}: {
	extension: ExtensionRow;
	onClose: () => void;
}) {
	const session = useAppSession();
	const members = useOrganizationMembers(session.activeOrganization?.id);
	const client = useQueryClient();
	const queryKey = ["extension-users", session.activeOrganization?.id, extension.id];
	const path = `/extensions/${extension.id}/users`;
	const assignments = useQuery({ queryKey, queryFn: () => apiFetch<{ data: Assignment[] }>(path) });
	const [userId, setUserId] = useState("");
	const [role, setRole] = useState<Assignment["role"]>("primary");
	const mutation = useMutation({
		mutationFn: (assignmentId?: string) =>
			apiFetch(assignmentId ? `${path}/${assignmentId}` : path, {
				method: assignmentId ? "DELETE" : "POST",
				body: assignmentId ? undefined : JSON.stringify({ userId, role }),
			}),
		onSuccess: async () => {
			setUserId("");
			await Promise.all([
				client.invalidateQueries({ queryKey }),
				client.invalidateQueries({
					queryKey: queryKeys.softphoneCredentials(session.activeOrganization?.id ?? ""),
				}),
			]);
		},
	});
	const error = mutation.error ?? assignments.error ?? members.error;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !mutation.isPending) {
					onClose();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Users for extension {extension.number}</DialogTitle>
					<DialogDescription>
						Assigned members can use this extension from their softphone. Primary assignments are
						preferred when a member has several extensions.
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<p role="alert" className="mb-3 text-sm text-danger">
						{error.message}
					</p>
				) : null}
				{assignments.isPending ? (
					<p>Loading assignments…</p>
				) : (
					<ul className="mb-4 space-y-2">
						{assignments.data?.data.map((assignment) => (
							<li key={assignment.id} className="flex items-center justify-between gap-2">
								<span>
									{members.data?.find((member) => member.userId === assignment.userId)?.name ??
										"Former member"}{" "}
									<span className="text-muted-foreground">({assignment.role})</span>
								</span>
								<Button
									size="sm"
									variant="ghost"
									disabled={mutation.isPending}
									onClick={() => mutation.mutate(assignment.id)}
								>
									Remove
								</Button>
							</li>
						))}
						{assignments.data?.data.length === 0 ? <li>No users assigned.</li> : null}
					</ul>
				)}
				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						mutation.mutate(undefined);
					}}
				>
					<label htmlFor="extension-user-member" className="block text-sm">
						Member
					</label>
					<select
						id="extension-user-member"
						className={inputClassName}
						value={userId}
						onChange={(event) => setUserId(event.target.value)}
						required
						disabled={members.isPending || assignments.isPending || mutation.isPending}
					>
						<option value="">Choose a member</option>
						{members.data
							?.filter(
								(member) => !assignments.data?.data.some((row) => row.userId === member.userId),
							)
							.map((member) => (
								<option key={member.userId} value={member.userId}>
									{member.name} ({member.email})
								</option>
							))}
					</select>
					<label htmlFor="extension-user-role" className="block text-sm">
						Assignment
					</label>
					<select
						id="extension-user-role"
						className={inputClassName}
						value={role}
						onChange={(event) => setRole(event.target.value as Assignment["role"])}
						disabled={mutation.isPending}
					>
						<option value="primary">Primary</option>
						<option value="shared">Shared</option>
						<option value="delegate">Delegate</option>
					</select>
					<div className="flex justify-end gap-2">
						<Button type="button" onClick={onClose} disabled={mutation.isPending}>
							Done
						</Button>
						<Button
							type="submit"
							variant="primary"
							disabled={!userId || mutation.isPending || Boolean(assignments.error)}
						>
							Assign user
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
