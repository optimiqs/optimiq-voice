"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { toast } from "~/components/ui/toast";
import {
	fetchMyOrganizations,
	fetchOrganizationMembers,
	type OrganizationMemberSummary,
	type OrganizationView,
} from "~/lib/api-client";
import { authErrorMessage, organization, type Invitation } from "~/lib/auth-client";
import { queryKeys } from "~/lib/query-keys";

/**
 * Organization and membership server state.
 *
 * READS go through `/api/v1/*`, because that is where the API resolves a membership role into the
 * permission set the guard enforces. WRITES go through better-auth's own organization endpoints,
 * which own invitations, role changes and removal. Splitting them this way keeps one owner per
 * concern instead of two half-implementations of membership.
 *
 * Every mutation invalidates by key factory, never by inline array — see `lib/query-keys.ts`.
 */

export function useMyOrganizations(): UseQueryResult<readonly OrganizationView[]> {
	return useQuery({
		queryKey: queryKeys.organizations(),
		queryFn: fetchMyOrganizations,
	});
}

export function useOrganizationMembers(
	organizationId: string | undefined,
): UseQueryResult<readonly OrganizationMemberSummary[]> {
	return useQuery({
		queryKey: queryKeys.members(organizationId ?? ""),
		queryFn: () => fetchOrganizationMembers(organizationId as string),
		enabled: Boolean(organizationId),
	});
}

export function useOrganizationInvitations(
	organizationId: string | undefined,
): UseQueryResult<readonly Invitation[]> {
	return useQuery({
		queryKey: queryKeys.invitations(organizationId ?? ""),
		queryFn: async () => {
			const result = await organization.listInvitations({
				query: { organizationId: organizationId as string },
			});
			if (result.error) {
				throw new Error(authErrorMessage(result.error));
			}
			return (result.data ?? []) as readonly Invitation[];
		},
		enabled: Boolean(organizationId),
	});
}

/**
 * better-auth requires a slug and rejects duplicates, so one is derived from the name rather than
 * asked for: a first-run form that demands a URL slug before the user has a phone system is
 * friction with no payoff. Collisions surface as a server error the caller can show.
 */
export function slugify(name: string): string {
	const base = name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 40);
	return base.length > 0 ? base : `org-${Date.now().toString(36)}`;
}

export function useCreateOrganization() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (name: string) => {
			const result = await organization.create({ name: name.trim(), slug: slugify(name) });
			if (result.error) {
				throw new Error(authErrorMessage(result.error));
			}
			const created = result.data;
			// A newly created organization is useless until the session is scoped to it.
			const activated = await organization.setActive({ organizationId: created.id });
			if (activated.error) {
				throw new Error(authErrorMessage(activated.error));
			}
			return created;
		},
		onSuccess: async () => {
			await queryClient.cancelQueries();
			queryClient.clear();
			toast.success("Organization created");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useRenameOrganization(organizationId: string | undefined) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (name: string) => {
			const result = await organization.update({
				organizationId: organizationId as string,
				data: { name: name.trim() },
			});
			if (result.error) {
				throw new Error(authErrorMessage(result.error));
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.session() });
			await queryClient.invalidateQueries({ queryKey: queryKeys.organizations() });
			toast.success("Organization renamed");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useInviteMember(organizationId: string | undefined) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({ email, role }: { email: string; role: string }) => {
			const result = await organization.inviteMember({
				email: email.trim(),
				role: role as never,
				organizationId,
			});
			if (result.error) {
				throw new Error(authErrorMessage(result.error));
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.invitations(organizationId ?? ""),
			});
			toast.success("Invitation sent");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useCancelInvitation(organizationId: string | undefined) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (invitationId: string) => {
			const result = await organization.cancelInvitation({ invitationId });
			if (result.error) {
				throw new Error(authErrorMessage(result.error));
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.invitations(organizationId ?? ""),
			});
			toast.success("Invitation revoked");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useUpdateMemberRole(organizationId: string | undefined) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({ memberId, role }: { memberId: string; role: string }) => {
			const result = await organization.updateMemberRole({
				memberId,
				role: role as never,
				organizationId,
			});
			if (result.error) {
				throw new Error(authErrorMessage(result.error));
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.members(organizationId ?? "") });
			// The caller may have changed their own role, which changes what the UI may show.
			await queryClient.invalidateQueries({ queryKey: queryKeys.session() });
			toast.success("Role updated");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useRemoveMember(organizationId: string | undefined) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (memberIdOrEmail: string) => {
			const result = await organization.removeMember({ memberIdOrEmail, organizationId });
			if (result.error) {
				throw new Error(authErrorMessage(result.error));
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.members(organizationId ?? "") });
			toast.success("Member removed");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}
