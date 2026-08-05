import { memo } from "react";
import { TooltipRoot } from "./tooltip.styles";
import type { TooltipProps as MuiTooltipProps } from "@mui/material/Tooltip";

export type TooltipProps = MuiTooltipProps;

export const Tooltip = memo((props: TooltipProps) => (
	<TooltipRoot
		arrow
		{...props}
		classes={{ popper: props.className }}
		placement={props.placement || "top"}
	/>
));

Tooltip.displayName = "Tooltip";
