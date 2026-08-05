import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useCreateAgent as useCreate } from "~/agents/services/agents.service";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import type { Schema } from "./create-agent.schema";

export const useCreateAgent = () => {
	/** Retrieves the current workspace ID for building navigation paths. */
	const workspaceId = useWorkspaceId();

	/** Hook to programmatically navigate between pages. */
	const navigate = useNavigate();

	/**
	 * Handler for navigating back to the workspace agents page.
	 * Uses view transitions for smoother page transitions (if supported).
	 */
	const onGoBack = useCallback(() => {
		navigate(`/workspaces/${workspaceId}/sip-network/agents`, {
			viewTransition: true,
		});
	}, [navigate, workspaceId]);

	/** Custom hook to create a agent via API with optimistic updates. */
	const { mutateAsync, isPending } = useCreate();

	/**
	 * Handler called after form submission.
	 * Submits the data, shows a toast, and navigates back to the agents page.
	 *
	 * @param {Schema} data - The validated form data from the form component.
	 */
	const onSave = useCallback(
		async (data: Schema) => {
			try {
				await mutateAsync(data);
				toast("Agent created successfully!");
				onGoBack();
			} catch (error) {
				toast(getErrorMessage(error));
			}
		},
		[mutateAsync, onGoBack],
	);

	/**
	 * Renders the Create Agent page layout.
	 */
	return {
		onGoBack,
		onSave,
		isPending,
	};
};
