import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useCreateApiKey as useCreate } from "~/api-keys/services/api-keys.service";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import type { Schema } from "./create-api-key.schema";

export const useCreateApiKey = () => {
	/** Retrieves the current workspace ID for building navigation paths. */
	const workspaceId = useWorkspaceId();

	/** Hook to programmatically navigate between pages. */
	const navigate = useNavigate();

	/**
	 * Handler for navigating back to the workspace apiKeys page.
	 * Uses view transitions for smoother page transitions (if supported).
	 */
	const onGoBack = useCallback(() => {
		navigate(`/workspaces/${workspaceId}/api-keys`, {
			viewTransition: true,
		});
	}, [navigate, workspaceId]);

	/** Custom hook to create a apiKey via API with optimistic updates. */
	const { mutateAsync, isPending, data } = useCreate();

	/**
	 * Handler called after form submission.
	 * Submits the data, shows a toast, and navigates back to the apiKeys page.
	 *
	 * @param {Schema} data - The validated form data from the form component.
	 */
	const onSave = useCallback(
		async (data: Schema) => {
			try {
				await mutateAsync(data);
				toast("API Key created successfully!");
			} catch (error) {
				toast(getErrorMessage(error));
			}
		},
		[mutateAsync],
	);

	/**
	 * Renders the Create ApiKey page layout.
	 */
	return {
		onGoBack,
		onSave,
		isPending,
		data,
	};
};
