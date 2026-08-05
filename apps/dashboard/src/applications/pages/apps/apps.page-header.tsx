import { useCallback } from "react";
import { useNavigate } from "react-router";
import { Icon } from "~/core/components/design-system/icons/icons";
import { Button } from "~/core/components/design-system/ui/button/button";
import { PageHeader } from "~/core/components/general/page/page-header";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";

/**
 * Header component for the Voice Applications page.
 * Displays the page title, description, and a button to create a new application.
 */
export function ApplicationsPageHeader() {
	/** Provides navigation functionality from react-router. */
	const navigate = useNavigate();

	/** Retrieves the current workspace ID from context or hook. */
	const workspaceId = useWorkspaceId();

	/**
	 * Navigates to the application creation page for the current workspace.
	 * Wrapped in useCallback for memoization and performance optimization.
	 */
	const onCreateNewApplication = useCallback(() => {
		navigate(`/workspaces/${workspaceId}/applications/create`, {
			viewTransition: true, // Enables smooth page transition animations
		});
	}, [navigate, workspaceId]);

	return (
		<PageHeader
			title="Voice Applications"
			description="Manage your External and Autopilot applications here. Autopilot uses LLMs to handle conversations; External lets you run custom business logic."
			actions={
				<Button
					variant="outlined"
					size="small"
					onClick={onCreateNewApplication}
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
					Create New Application
				</Button>
			}
		/>
	);
}
