import { useCallback } from "react";
import { useNavigate } from "react-router";
import { Icon } from "~/core/components/design-system/icons/icons";
import { Button } from "~/core/components/design-system/ui/button/button";
import { PageHeader } from "~/core/components/general/page/page-header";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";

/**
 * Header component for the Voice Agents page.
 * Displays the page title, description, and a button to create a new agent.
 */
export function AgentsPageHeader() {
	/** Provides navigation functionality from react-router. */
	const navigate = useNavigate();

	/** Retrieves the current workspace ID from context or hook. */
	const workspaceId = useWorkspaceId();

	/**
	 * Navigates to the agent creation page for the current workspace.
	 * Wrapped in useCallback for memoization and performance optimization.
	 */
	const onCreateNewAgent = useCallback(() => {
		navigate(`/workspaces/${workspaceId}/sip-network/agents/create`, {
			viewTransition: true, // Enables smooth page transition animations
		});
	}, [navigate, workspaceId]);

	return (
		<PageHeader
			title="Agents"
			description="SIP Agents in the same domain can call each other over VoIP using a softphone like Zoiper."
			actions={
				<Button
					variant="outlined"
					size="small"
					onClick={onCreateNewAgent}
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
					Create New Agent
				</Button>
			}
		/>
	);
}
