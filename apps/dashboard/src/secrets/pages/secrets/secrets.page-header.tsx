import { useCallback } from "react";
import { useNavigate } from "react-router";
import { Icon } from "~/core/components/design-system/icons/icons";
import { Button } from "~/core/components/design-system/ui/button/button";
import { PageHeader } from "~/core/components/general/page/page-header";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";

/**
 * Header component for the Voice Secretss page.
 * Displays the page title, description, and a button to create a new secret.
 */
export function SecretsPageHeader() {
	/** Provides navigation functionality from react-router. */
	const navigate = useNavigate();

	/** Retrieves the current workspace ID from context or hook. */
	const workspaceId = useWorkspaceId();

	/**
	 * Navigates to the secret creation page for the current workspace.
	 * Wrapped in useCallback for memoization and performance optimization.
	 */
	const onCreateNewSecrets = useCallback(() => {
		navigate(`/workspaces/${workspaceId}/secrets/create`, {
			viewTransition: true, // Enables smooth page transition animations
		});
	}, [navigate, workspaceId]);

	return (
		<PageHeader
			title="Secrets"
			description="Manage encrypted variables used in your apps and APIs. Only available within this workspace."
			actions={
				<Button
					variant="outlined"
					size="small"
					onClick={onCreateNewSecrets}
					endIcon={
						<Icon
							name="Add"
							sx={{
								fontSize: "16px !important",
								color: "inherit",
							}}
						/>
					}
				>
					Create New Secret
				</Button>
			}
		/>
	);
}
