import { Box } from "@mui/material";
import { useThemeMode } from "~/core/providers/styling/mui.provider";
import { Switch } from "../../design-system/ui/switch/switch";
import { Typography } from "../../design-system/ui/typography/typography";

export const ThemeSwitch = () => {
	const { isDarkMode, changeTheme } = useThemeMode();

	const handleThemeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		changeTheme(event.target.checked ? "dark" : "light");
	};

	return (
		<Box
			sx={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				width: "100%",
			}}
		>
			<Box>
				<Typography variant="body-medium" sx={{ fontWeight: 600 }}>
					Dark Mode
				</Typography>
				<Typography variant="body-small" color="text.secondary">
					Switch between light and dark theme
				</Typography>
			</Box>
			<Switch value={isDarkMode} onChange={handleThemeChange} />
		</Box>
	);
};

ThemeSwitch.displayName = "ThemeSwitch";
