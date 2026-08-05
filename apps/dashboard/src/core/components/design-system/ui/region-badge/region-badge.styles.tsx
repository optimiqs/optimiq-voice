import Box from "@mui/material/Box";
import { styled } from "@mui/material/styles";
import { type CSSProperties } from "react";

const commonStyles: CSSProperties = {
	display: "inline-flex",
	justifyContent: "center",
	alignItems: "center",
	gap: "10px",
	fontFamily: "Roboto Mono",
	fontSize: "10px",
	fontStyle: "normal",
	fontWeight: 700,
	lineHeight: "21px",
	textTransform: "uppercase",
	textAlign: "center",
	fontFeatureSettings: "'liga' off, 'clig' off",
};

export const DrawerRegionBadge = styled(Box)(({ theme }) => ({
	...commonStyles,
	padding: "0px 4px",
	backgroundColor: theme.palette.base["06"],
	color: theme.palette.base["03"],
	borderRadius: "20px",
}));

export const LandingPageRegionBadge = styled(Box)(({ theme }) => ({
	...commonStyles,
	padding: "2px 8px",
	backgroundColor: theme.palette.brand.main,
	color: theme.palette.brand["06"],
	borderRadius: "40px",
}));
