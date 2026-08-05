import { Box, ClickAwayListener, Fade, Grow } from "@mui/material";
import { useState, useRef, useEffect } from "react";
import { ellipsis } from "~/core/helpers/ellipsis";
import { Icon } from "../../design-system/icons/icons";
import { Typography } from "../../design-system/ui/typography/typography";
import {
	WorkspaceOption,
	WorkspaceTrigger,
	WorkspaceUnifiedDropdown,
} from "./workspace-selector.styles";
import type { Workspace } from "./sidebar.interfaces";
import type React from "react";

const DEFAULT_WORKSPACE = [{ id: "ADD", name: "New Workspace +" }];

export interface FilterSearchBySelectorProps {
	selectedWorkspaceId: string;
	workspaces: Workspace[];
	onSelect: (id: string) => void;
	animationType?: "fade" | "grow";
	animationDuration?: number;
	placeholder?: string;
	region?: string;
}

export const WorkspaceSelector: React.FC<FilterSearchBySelectorProps> = ({
	workspaces,
	onSelect,
	selectedWorkspaceId,
	animationType = "fade",
	animationDuration = 200,
	region = "nyc01",
	placeholder = "Default Workspace",
}) => {
	const [open, setOpen] = useState(false);
	const [shouldRender, setShouldRender] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);

	const selectedFilterLabel =
		workspaces.find((option) => option.id === selectedWorkspaceId)?.name || placeholder;

	const handleFilterSelect = (filterId: string) => {
		onSelect(filterId);
		setOpen(false);
	};

	const handleToggle = () => {
		setOpen((prevOpen) => !prevOpen);
	};

	const handleClose = (event: MouseEvent | TouchEvent) => {
		if (containerRef.current && containerRef.current.contains(event.target as HTMLElement)) {
			return;
		}
		setOpen(false);
	};

	useEffect(() => {
		if (open) {
			setShouldRender(true);
		} else {
			const timer = setTimeout(() => setShouldRender(false), animationDuration);
			return () => clearTimeout(timer);
		}
	}, [open, animationDuration]);

	const renderAnimatedDropdown = () => {
		if (!shouldRender) return null;

		const dropdown = (
			<WorkspaceUnifiedDropdown>
				<WorkspaceTrigger onClick={handleToggle}>
					<Box display="flex" flexDirection="column" gap="4px">
						<Typography variant="mono-small" sx={{ color: "base.04" }}>
							{region}
						</Typography>
						<Typography variant="body-medium">{ellipsis(selectedFilterLabel)}</Typography>
					</Box>
					<Icon name={"UnfoldLess"} />
				</WorkspaceTrigger>

				{[...workspaces, ...DEFAULT_WORKSPACE].map((option) => (
					<WorkspaceOption
						key={option.id}
						onClick={() => handleFilterSelect(option.id)}
						data-selected={option.id === selectedWorkspaceId}
					>
						{ellipsis(option.name, 50)}
					</WorkspaceOption>
				))}
			</WorkspaceUnifiedDropdown>
		);

		if (animationType === "fade") {
			return (
				<Fade in={open} timeout={animationDuration} unmountOnExit={false}>
					{dropdown}
				</Fade>
			);
		}

		return (
			<Grow
				in={open}
				timeout={animationDuration}
				style={{ transformOrigin: "0 0 0" }}
				unmountOnExit={false}
			>
				{dropdown}
			</Grow>
		);
	};

	return (
		<ClickAwayListener onClickAway={handleClose}>
			<Box
				sx={{
					display: "flex",
					flexDirection: "column",
					width: "100%",
					position: "relative",
				}}
				ref={containerRef}
			>
				<WorkspaceTrigger onClick={handleToggle}>
					<Box display="flex" flexDirection="column" gap="4px">
						<Typography variant="mono-small" sx={{ color: "base.04" }}>
							{region}
						</Typography>
						<Typography variant="body-medium">{ellipsis(selectedFilterLabel)}</Typography>
					</Box>
					<Icon name={"UnfoldMore"} />
				</WorkspaceTrigger>

				{renderAnimatedDropdown()}
			</Box>
		</ClickAwayListener>
	);
};
