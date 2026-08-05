import { styled } from "@mui/material/styles";
import Switch from "@mui/material/Switch";

export const SwitchRoot = styled(Switch)(({ theme }) => ({
	width: 32,
	height: 16,
	padding: 0,
	display: "flex",
	"&:active": {
		"& .MuiSwitch-thumb": {
			width: 14,
		},
		"& .MuiSwitch-switchBase.Mui-checked": {
			transform: "translateX(16px)",
		},
	},
	"& .MuiSwitch-switchBase": {
		padding: 2,
		transition: theme.transitions.create(["transform"], {
			duration: 200,
		}),
		color: theme.palette.brand["05"],
		"&.Mui-checked": {
			transform: "translateX(16px)",
			color: theme.palette.brand.main,
			"& + .MuiSwitch-track": {
				opacity: 1,
				backgroundColor: theme.palette.brand["02"],
			},
		},
	},
	"& .MuiSwitch-thumb": {
		boxShadow: "0 2px 4px 0 rgb(0 35 11 / 20%)",
		width: 12,
		height: 12,
		borderRadius: 6,
		transition: theme.transitions.create(["width", "transform"], {
			duration: 200,
		}),
	},
	"& .MuiSwitch-track": {
		borderRadius: 8,
		opacity: 1,
		backgroundColor: "rgba(0,0,0,.25)",
		boxSizing: "border-box",
		...theme.applyStyles("dark", {
			backgroundColor: "rgba(255,255,255,.35)",
		}),
	},
}));
