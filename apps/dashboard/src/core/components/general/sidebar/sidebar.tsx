import { Box } from "@mui/material";
import { useRef } from "react";
import { IS_PRIVATE_BETA } from "~/core/sdk/stores/optimiq-voice.config";
import { RegionBadge } from "../../design-system/ui/region-badge/region-badge";
import { Typography } from "../../design-system/ui/typography/typography";
import NavItem from "./sidebar-nav-item";
import { useSidebarItems } from "./sidebar-navigation.const";
import { SidebarProvider } from "./sidebar.context";
import {
  SidebarContainer,
  SidebarContent,
  SidebarFooter,
  SidebarNavigation,
  SidebarWrapper
} from "./sidebar.styles";
import { WorkspaceSelector } from "./workspace-selector";
import type { Workspace } from "./sidebar.interfaces";

const VERSION = import.meta.env.DASHBOARD_VERSION || "unset";

export interface SidebarProps {
  workspaces: Workspace[];
  selectedWorkspaceId: string;
  onSelectWorkspace: (id: string) => void;
  navigate: (href: string) => void;
  pathname: string;
}

const Sidebar = ({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  navigate,
  pathname
}: SidebarProps) => {
  const { current: year } = useRef(new Date().getFullYear());

  const items = useSidebarItems();

  return (
    <SidebarProvider {...{ navigate, pathname }}>
      <SidebarContainer>
        <SidebarWrapper>
          <SidebarContent>
            <WorkspaceSelector
              workspaces={workspaces}
              selectedWorkspaceId={selectedWorkspaceId}
              onSelect={onSelectWorkspace}
            />
            <SidebarNavigation>
              {items.map((item) => (
                <NavItem key={item.label} item={item} />
              ))}
            </SidebarNavigation>
          </SidebarContent>
          <SidebarFooter>
            {IS_PRIVATE_BETA && (
              <Box display="flex" justifyContent="center" mb={1}>
                <RegionBadge type="drawer">Private Beta</RegionBadge>
              </Box>
            )}
            <Typography variant="mono-small">
              &copy; {year}, OPTIMIQ VOICE. {VERSION}
            </Typography>
          </SidebarFooter>
        </SidebarWrapper>
      </SidebarContainer>
    </SidebarProvider>
  );
};

export default Sidebar;
