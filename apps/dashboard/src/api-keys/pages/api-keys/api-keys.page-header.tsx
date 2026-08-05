import { useCallback } from "react";
import { useNavigate } from "react-router";
import { Icon } from "~/core/components/design-system/icons/icons";
import { Button } from "~/core/components/design-system/ui/button/button";
import { PageHeader } from "~/core/components/general/page/page-header";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";

/**
 * Header component for the Voice API Keys page.
 * Displays the page title, description, and a button to create a new API key.
 */
export function ApiKeysPageHeader() {
  /** Provides navigation functionality from react-router. */
  const navigate = useNavigate();

  /** Retrieves the current workspace ID from context or hook. */
  const workspaceId = useWorkspaceId();

  /**
   * Navigates to the API key creation page for the current workspace.
   * Wrapped in useCallback for memoization and performance optimization.
   */
  const onCreateNewApiKey = useCallback(() => {
    navigate(`/workspaces/${workspaceId}/api-keys/create`, {
      viewTransition: true // Enables smooth page transition animations
    });
  }, [navigate, workspaceId]);

  return (
    <PageHeader
      title="API keys"
      description="Use API Keys to access Optimiq Voice's APIs securely. Keys are encrypted and limited to this workspace."
      actions={
        <Button
          variant="outlined"
          size="small"
          onClick={onCreateNewApiKey}
          endIcon={
            <Icon
              name="Add"
              sx={{
                fontSize: "16px !important",
                color: "inherit"
              }}
            />
          }
        >
          Create New API key
        </Button>
      }
    />
  );
}
