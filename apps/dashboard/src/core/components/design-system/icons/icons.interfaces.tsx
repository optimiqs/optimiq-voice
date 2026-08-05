import type { ICON } from "./icons.const";
import type { SvgIconProps } from "@mui/material";

export interface IconProps extends SvgIconProps {
	name: keyof typeof ICON;
	fontSize?: "small" | "medium" | "large" | "inherit";
}
