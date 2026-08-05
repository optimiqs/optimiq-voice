import { useCallback } from "react";
import { useNavigate } from "react-router";
import { Icon } from "~/core/components/design-system/icons/icons";
import { Button } from "~/core/components/design-system/ui/button/button";
import { PageHeader } from "~/core/components/general/page/page-header";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";

/**
 * Header component for the Voice Acls page.
 * Displays the page title, description, and a button to create a new acl.
 */
export function AclsPageHeader() {
	/** Provides navigation functionality from react-router. */
	const navigate = useNavigate();

	/** Retrieves the current workspace ID from context or hook. */
	const workspaceId = useWorkspaceId();

	/**
	 * Navigates to the acl creation page for the current workspace.
	 * Wrapped in useCallback for memoization and performance optimization.
	 */
	const onCreateNewAcl = useCallback(() => {
		navigate(`/workspaces/${workspaceId}/sip-network/acls/create`, {
			viewTransition: true, // Enables smooth page transition animations
		});
	}, [navigate, workspaceId]);

	return (
		<PageHeader
			title="IP/CIDR Access Control List (ACL)"
			description="Control access from external networks by creating allow or deny rules."
			actions={
				<Button
					variant="outlined"
					size="small"
					onClick={onCreateNewAcl}
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
					Create New Acl
				</Button>
			}
		/>
	);
}
