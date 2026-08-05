import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";

export const GoBackRoot = styled(Box)(({ theme }) => ({
	display: "flex",
	alignItems: "center",
	cursor: "pointer",
	width: "fit-content",
	color: theme.palette.base["04"],
	transition: "all 0.2s ease-in-out",

	"&:hover": {
		color: theme.palette.base["02"],
	},

	"&.disabled": {
		color: theme.palette.base["04"],
		cursor: "not-allowed",
		pointerEvents: "none",
	},
}));
