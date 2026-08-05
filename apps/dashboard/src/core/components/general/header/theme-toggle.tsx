import { IconButton, Tooltip } from "@mui/material";
import { useThemeMode } from "~/core/providers/styling/mui.provider";
import { Icon } from "../../design-system/icons/icons";

export const ThemeToggle = () => {
	const { isDarkMode, changeTheme } = useThemeMode();

	return (
		<Tooltip title={isDarkMode ? "Switch to light" : "Switch to dark"}>
			<IconButton
				onClick={() => changeTheme(isDarkMode ? "light" : "dark")}
				sx={{ fontSize: 18, color: "base.02" }}
				aria-label="Toggle color scheme"
			>
				<Icon name={isDarkMode ? "LightMode" : "DarkMode"} fontSize="inherit" />
			</IconButton>
		</Tooltip>
	);
};

ThemeToggle.displayName = "ThemeToggle";
