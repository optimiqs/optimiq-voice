import CalendarTodayOutlinedIcon from "@mui/icons-material/CalendarTodayOutlined";
import PersonOutlinedIcon from "@mui/icons-material/PersonOutlined";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import { Box } from "@mui/material";
import React, { useMemo } from "react";
import { RegionBadge } from "../region-badge/region-badge";
import {
	WorkspaceCardRoot,
	StyledDescription,
	StyledDateContainer,
	StyledBottomContainer,
	StyledDate,
	StyledIcon,
	StyledOwnerContainer,
	StyledOwnerIcon,
	StyledOwnerText,
} from "./workspace-card.styles";

export interface WorkspaceCardProps extends React.HTMLAttributes<HTMLDivElement> {
	region?: string;
	description?: string;
	date?: string;
	owner?: {
		ref: string;
		name: string;
		email: string;
	};
	disabled?: boolean;
	workspaceRef?: React.RefObject<HTMLDivElement>;
	onSettingsClick?: () => void;
}

export const WorkspaceCard: React.FC<WorkspaceCardProps> = ({
	onClick,
	region,
	description,
	date,
	owner,
	disabled = false,
	workspaceRef,
	onSettingsClick,
}) => {
	return (
		<WorkspaceCardRoot
			onClick={!disabled ? onClick : undefined}
			disabled={disabled}
			workspaceVariant="regular"
			ref={workspaceRef}
		>
			<Box
				sx={{
					height: "100%",
					width: "100%",
					display: "flex",
					flexDirection: "column",
					flexGrow: 1,
					alignItems: "center",
					justifyContent: "end",
				}}
			>
				<Box sx={{ width: "100%" }}>
					{region && <RegionBadge type="landing-page">{region}</RegionBadge>}
					{description && <StyledDescription>{description}</StyledDescription>}
					{owner && (
						<StyledOwnerContainer>
							<StyledOwnerIcon>
								<PersonOutlinedIcon />
							</StyledOwnerIcon>
							<StyledOwnerText>Owner: {owner.name}</StyledOwnerText>
						</StyledOwnerContainer>
					)}
					<Box sx={{ flexGrow: 1 }} />
					<StyledBottomContainer>
						<StyledDateContainer>
							<StyledIcon>
								<CalendarTodayOutlinedIcon />
							</StyledIcon>
							{date && <StyledDate>{date}</StyledDate>}
						</StyledDateContainer>
						<StyledIcon onClick={onSettingsClick} clickable={!disabled && !!onSettingsClick}>
							<SettingsOutlinedIcon />
						</StyledIcon>
					</StyledBottomContainer>
				</Box>
			</Box>
		</WorkspaceCardRoot>
	);
};
