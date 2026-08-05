import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useCreateAcl as useCreate } from "~/acls/services/acls.service";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import type { Schema } from "./create-acl.schema";

/**
 * Custom hook to handle the creation of a new ACL (Access Control List).
 *
 * Integrates:
 * - Navigation logic.
 * - API calls via mutateAsync from the useCreateAcl service.
 * - Error handling and user feedback via toasts.
 *
 * Provides:
 * - onGoBack: navigates back to the ACLs page.
 * - onSave: submits the ACL creation request and shows feedback.
 * - isPending: indicates whether the creation process is ongoing.
 *
 * @returns {Object} The handlers and state for managing ACL creation.
 */
export const useCreateAcl = () => {
	/** Retrieves the current workspace ID to build relative navigation paths. */
	const workspaceId = useWorkspaceId();

	/** Hook to programmatically navigate between pages in the app. */
	const navigate = useNavigate();

	/**
	 * Navigates back to the workspace ACLs page.
	 *
	 * Uses the view transitions API for smoother page transitions (if supported).
	 *
	 * @returns {void}
	 */
	const onGoBack = useCallback(() => {
		navigate(`/workspaces/${workspaceId}/sip-network/acls`, {
			viewTransition: true,
		});
	}, [navigate, workspaceId]);

	/** Initializes the mutation hook to create a new ACL entry in the backend. */
	const { mutateAsync, isPending } = useCreate();

	/**
	 * Handles the form submission.
	 *
	 * - Extracts 'allow' and 'deny' rule lists from the combined 'rules' field.
	 * - Calls the mutateAsync API to create the ACL.
	 * - Shows success or error notifications based on the outcome.
	 * - Navigates back to the ACLs page on success.
	 *
	 * @param {Schema} data - The validated form data from the ACL form.
	 * @returns {Promise<void>}
	 */
	const onSave = useCallback(
		async ({ rules, ...data }: Schema, disableNavigation?: boolean) => {
			/** Transform the unified 'rules' field into separate 'allow' and 'deny' lists. */
			const deny = rules.filter((rule) => rule.type === "deny").map(({ name }) => name);

			const allow = rules.filter((rule) => rule.type === "allow").map(({ name }) => name);

			try {
				/** Calls the API to create the ACL entry. */
				const acl = await mutateAsync({ ...data, deny, allow });

				/** Shows a success toast notification. */
				toast("ACL created successfully!");

				if (disableNavigation) {
					/** If navigation is disabled, return the created ACL. */
					return acl;
				}

				/** Navigates back to the ACLs page. */
				onGoBack();

				return acl;
			} catch (error) {
				toast(getErrorMessage(error));
			}
		},
		[mutateAsync, onGoBack],
	);

	/** Exposes the handlers and pending state to the component using this hook. */
	return {
		onGoBack,
		onSave,
		isPending,
	};
};
