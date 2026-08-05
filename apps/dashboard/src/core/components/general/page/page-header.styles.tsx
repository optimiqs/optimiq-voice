import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";
import { Typography } from "../../design-system/ui/typography/typography";

export const PageHeaderRoot = styled(Box)(({ theme }) => ({
	marginBottom: theme.spacing(5),
	width: "100%",
	display: "flex",
	flexDirection: "column",
	gap: theme.spacing(1.5),
}));

export const PageHeaderRow = styled(Box)(({ theme }) => ({
	display: "flex",
	justifyContent: "space-between",
	alignItems: "flex-start",
	width: "100%",
	gap: theme.spacing(4),
}));

export const PageHeaderTitleContainer = styled(Box)(({ theme }) => ({
	display: "flex",
	flexDirection: "column",
	gap: theme.spacing(1),
}));

export const PageHeaderTitleText = styled(Typography)({
	overflow: "hidden",
	display: "-webkit-box",
	WebkitBoxOrient: "vertical",
	WebkitLineClamp: 1,
});

export const PageHeaderDescriptionText = styled(Typography)({
	maxWidth: 400,
});
