import { Box, styled } from "@mui/material";
import { Typography } from "~/core/components/design-system/ui/typography/typography";

export const ContentContainer = styled(Box)(({ theme }) => ({
	marginTop: theme.spacing(6),
}));

export const SectionContainer = styled(Box)(() => ({
	width: "100%",
}));

export const SectionTitle = styled(Typography)(({ theme }) => ({
	color: theme.palette.text.secondary,
	fontSize: "11px !important",
	fontWeight: 500,
	fontFamily: "Roboto Mono !important",
	textTransform: "uppercase",
	letterSpacing: "0.1em",
	marginBottom: "8px",
}));

export const CardsContainer = styled(Box)(({ theme }) => ({
	display: "flex",
	flexDirection: "column",
	gap: theme.spacing(2),
}));
