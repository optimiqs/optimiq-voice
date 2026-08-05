import { useCallback } from "react";
import { useNavigate } from "react-router";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useCreateCredential as useCreate } from "~/credentials/services/credentials.service";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import type { Schema } from "./create-credential.schema";

export const useCreateCredential = () => {
	/** Retrieves the current workspace ID for building navigation paths. */
	const workspaceId = useWorkspaceId();

	/** Hook to programmatically navigate between pages. */
	const navigate = useNavigate();

	/**
	 * Handler for navigating back to the workspace credentials page.
	 * Uses view transitions for smoother page transitions (if supported).
	 */
	const onGoBack = useCallback(() => {
		navigate(`/workspaces/${workspaceId}/sip-network/credentials`, {
			viewTransition: true,
		});
	}, [navigate, workspaceId]);

	/** Custom hook to create a credential via API with optimistic updates. */
	const { mutateAsync, isPending } = useCreate();

	/**
	 * Handler called after form submission.
	 * Submits the data, shows a toast, and navigates back to the credentials page.
	 *
	 * @param {Schema} data - The validated form data from the form component.
	 */
	const onSave = useCallback(
		async (data: Schema, disableNavigation?: boolean) => {
			try {
				if (!data?.password) {
					toast("Please provide a password for the credentials.");
					return null;
				}

				const credentials = await mutateAsync(data);
				toast("Credential created successfully!");

				if (disableNavigation) return credentials;

				onGoBack();

				return credentials;
			} catch (error) {
				toast(getErrorMessage(error));
			}
		},
		[mutateAsync, onGoBack],
	);

	/**
	 * Renders the Create Credential page layout.
	 */
	return {
		onGoBack,
		onSave,
		isPending,
	};
};
