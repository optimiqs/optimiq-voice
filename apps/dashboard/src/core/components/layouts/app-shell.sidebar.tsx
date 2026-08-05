import { styled } from "@mui/material";
import { useCallback, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "~/auth/hooks/use-auth";
import { CreateWorkspaceModal } from "~/workspaces/components/containers/create-workspace/create-workspace.modal";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import Sidebar from "../general/sidebar/sidebar";

/**
 * AppShellSidebar component
 *
 * Renders the application's sidebar, including workspace navigation,
 * workspace switching logic, and a modal for creating new workspaces.
 */
export function AppShellSidebar() {
  /**
   * Retrieves the current workspace ID from the URL,
   * allowing the sidebar to highlight the selected workspace.
   */
  const workspaceId = useWorkspaceId();

  /**
   * Retrieves workspace data and relevant methods from the authentication context.
   */
  const { workspaces, currentWorkspace, onWorkspaceChange } = useAuth();

  /**
   * React Router hooks for navigation and accessing the current pathname.
   */
  const navigate = useNavigate();
  const { pathname } = useLocation();

  /**
   * Local state to control the visibility of the Create Workspace modal.
   */
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  /**
   * Handles navigation within the app using view transitions
   * for a smooth user experience.
   *
   * @param {string} to - The target path to navigate to.
   */
  const onNavigate = useCallback(
    (to: string) => navigate(to, { viewTransition: true }),
    [navigate]
  );

  /**
   * Handles workspace selection.
   * If the "Add Workspace" option is selected (id === "ADD"),
   * opens the Create Workspace modal.
   * Otherwise, updates the current workspace context and navigates.
   *
   * @param {string} id - The ID of the selected workspace.
   */
  const setSelectedWorkspaceId = useCallback(
    (id: string) => {
      if (id === "ADD") {
        setIsCreateModalOpen(true);
        return;
      }

      if (id !== currentWorkspace?.ref) {
        onWorkspaceChange(id);

        /**
         * Updates the current path to reflect the new workspace.
         * Maintains the rest of the path after the workspace ID.
         */
        const workspacePathMatch = pathname.match(
          /^\/workspaces\/[^\/]+(\/.*)?$/
        );

        /**
         * Extracts the rest of the path after the workspace ID,
         * if it exists, or defaults to an empty string.
         */
        const restOfPath = workspacePathMatch?.[1] ?? "";

        /**
         * Constructs the new path with the selected workspace ID
         * and the rest of the current path.
         */
        const newPath = `/workspaces/${encodeURIComponent(id)}${restOfPath}`;

        onNavigate(newPath);
      }
    },
    [currentWorkspace?.ref, onWorkspaceChange, onNavigate, pathname]
  );

  /**
   * Renders the sidebar component with the workspace list,
   * navigation logic, and the Create Workspace modal.
   */
  return (
    <>
      <AppShellAside>
        <Sidebar
          /**
           * Maps workspaces to the Sidebar component's expected format:
           * each workspace object includes an id and name.
           */
          workspaces={workspaces.map(({ ref, name }) => ({ id: ref, name }))}
          pathname={pathname}
          navigate={onNavigate}
          selectedWorkspaceId={workspaceId}
          onSelectWorkspace={setSelectedWorkspaceId}
        />
      </AppShellAside>

      <CreateWorkspaceModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />
    </>
  );
}

/**
 * Styled component for the app shell sidebar container.
 * Provides a consistent layout and theme-based styling.
 */
export const AppShellAside = styled("aside")(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  width: "250px",
  backgroundColor: theme.palette.bg.surface,
  borderRight: `1px solid ${theme.palette.base["06"]}`,
  height: "100%",
  overflow: "auto",
  ...theme.applyStyles("dark", {
    backgroundColor: theme.palette.bg.surface,
    borderRight: `1px solid ${theme.palette.base["06"]}`
  })
}));
