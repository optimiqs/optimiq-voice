import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "~/auth/hooks/use-auth";
import { WorkspaceCard } from "~/core/components/design-system/ui/workspace-card/workspace-card";
import { AddWorkspaceCard } from "~/core/components/design-system/ui/workspace-card/workspace-card-empty";
import { CreateWorkspaceModal } from "~/workspaces/components/containers/create-workspace/create-workspace.modal";
import {
  ContentWrapper,
  Subtitle,
  Title,
  WorkspaceContainer,
  WorkspaceGrid
} from "./workspaces.styles";
import type { Route } from "./+types/workspaces.page";

/**
 * Metadata function for this route.
 * Sets the page title for SEO and display.
 *
 * @param {Route.MetaArgs} _
 * @returns {Array} An array containing the page title.
 */
export function meta(_: Route.MetaArgs) {
  return [{ title: "Workspaces | Optimiq Voice" }];
}

/**
 * Workspaces page component
 *
 * Renders a list of the user's workspaces as cards,
 * with options to view, configure, and create new workspaces.
 */
export default function Workspaces() {
  /** React Router hook to handle navigation. */
  const navigate = useNavigate();

  /** Get the current user and their workspaces from the auth context. */
  const { user, workspaces } = useAuth();

  /** Local state to control the visibility of the Create Workspace modal. */
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  /**
   * Handles click on a workspace card.
   * Navigates the user to the workspace overview page.
   *
   * @param {string} workspaceRef - The reference ID of the selected workspace.
   */
  const onWorkspaceClick = useCallback(
    (workspaceRef: string) => {
      navigate(`/workspaces/${workspaceRef}`, { viewTransition: true });
    },
    [navigate]
  );

  /**
   * Handles click on a workspace card's settings.
   * Navigates the user to the workspace settings page.
   *
   * @param {string} workspaceRef - The reference ID of the selected workspace.
   */
  const onSettingsClick = useCallback(
    (workspaceRef: string) => {
      navigate(`/workspaces/${workspaceRef}/settings`, {
        viewTransition: true
      });
    },
    [navigate]
  );

  /**
   * Renders the workspace cards grid, the Add Workspace button, and the modal.
   */
  return (
    <>
      <WorkspaceContainer>
        <ContentWrapper>
          <Title variant="heading-large">
            {`Hey ${user.name}, welcome to Optimiq Voice! 👋`}
          </Title>

          <Subtitle variant="body-large">
            Create a workspace to power your Voice AI and manage your SIP
            network—all in one place.
          </Subtitle>

          <WorkspaceGrid>
            {workspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.ref}
                region={"NYC01"} // TODO: Replace with actual region data if available.
                description={workspace.name}
                owner={workspace.owner}
                onClick={() => onWorkspaceClick(workspace.ref)}
                onSettingsClick={() => onSettingsClick(workspace.ref)}
                date={
                  workspace.createdAt
                    ? workspace.createdAt.toLocaleDateString()
                    : "N/A"
                }
              />
            ))}

            {/* Card to trigger the creation of a new workspace */}
            <AddWorkspaceCard onClick={() => setIsCreateModalOpen(true)} />
          </WorkspaceGrid>
        </ContentWrapper>
      </WorkspaceContainer>

      {/* Modal to create a new workspace */}
      <CreateWorkspaceModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />
    </>
  );
}
