import Box from "@mui/material/Box";
import { styled } from "@mui/material/styles";

export const OverviewCardRoot = styled(Box)(({ theme }) => ({
	display: "flex",
	width: "100%",
	height: "76px",
	alignItems: "center",
	justifyContent: "space-between",
	paddingTop: "24px",
	paddingRight: "16px",
	paddingBottom: "24px",
	paddingLeft: "16px",
	borderRadius: "8px",
	border: "1px",
	borderStyle: "solid",
	borderColor: theme.palette.base["06"],
	gap: "12px",
	cursor: "pointer",
	backgroundColor: theme.palette.base["07"],
	transition: "all 0.2s ease-in-out",

	"&:hover": {
		borderColor: theme.palette.brand.main,
	},
}));

export const OverviewCardRootIcon = styled(Box)(({ theme }) => ({
	display: "flex",
	backgroundColor: theme.palette.brand["03"],
	padding: "4px",
	borderRadius: "4px",
	color: theme.palette.brand["05"],
}));

export const OverviewCardRootLabel = styled(Box)(() => ({
	flexGrow: 1,
	padding: "0px",
}));
