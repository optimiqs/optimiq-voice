import AddIcon from "@mui/icons-material/Add";
import { Box } from "@mui/material";
import React from "react";
import {
  WorkspaceCardRoot,
  StyledCardContentContainer,
  StyledNewWorkSpaceDescription,
  StyledAddIconContainer
} from "./workspace-card.styles";

export interface WorkspaceCardProps extends React.HTMLAttributes<HTMLDivElement> {
  disabled?: boolean;
  workspaceRef?: React.RefObject<HTMLDivElement>;
}

export const AddWorkspaceCard: React.FC<WorkspaceCardProps> = ({
  onClick,
  workspaceRef,
  disabled = false
}) => {
  return (
    <WorkspaceCardRoot
      onClick={!disabled ? onClick : undefined}
      disabled={disabled}
      ref={workspaceRef}
    >
      <StyledCardContentContainer>
        <Box
          sx={{
            height: "100%",
            alignContent: "center",
            justifyContent: "center",
            alignItems: "center",
            display: "flex",
            flexDirection: "column",
            flexGrow: 1
          }}
        >
          <StyledAddIconContainer
            disabled={disabled}
            className="workspace-icon"
          >
            <AddIcon />
          </StyledAddIconContainer>
          <StyledNewWorkSpaceDescription
            disabled={disabled}
            className="workspace-text"
          >
            New Workspace
          </StyledNewWorkSpaceDescription>
        </Box>
      </StyledCardContentContainer>
    </WorkspaceCardRoot>
  );
};
