import createEmotionCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import { CssBaseline, useColorScheme, type Theme } from "@mui/material";
import { ThemeProvider as MaterialThemeProvider } from "@mui/material/styles";
import React, { useCallback, useMemo } from "react";
import { theme as DEFAULT_THEME } from "./mui.theme";

const MODE_STORAGE_KEY = "optimiq-voice:theme";
const DEFAULT_MODE = "dark";
const cache = createEmotionCache({
	key: "optimiq-voice-mui-cache",
	prepend: true,
});

export interface ThemeProviderProps {
	children: React.ReactNode;
	theme?: Theme;
}

export const ThemeProvider = ({ children, theme }: ThemeProviderProps) => {
	return (
		<CacheProvider value={cache}>
			<MaterialThemeProvider
				theme={theme || DEFAULT_THEME}
				defaultMode={DEFAULT_MODE}
				modeStorageKey={MODE_STORAGE_KEY}
			>
				<CssBaseline enableColorScheme />
				{children}
			</MaterialThemeProvider>
		</CacheProvider>
	);
};

export const useThemeMode = () => {
	const { mode, setMode } = useColorScheme();

	const isDarkMode = useMemo(() => mode === "dark", [mode]);

	const changeTheme = useCallback(
		(newMode: "light" | "dark") => {
			setMode(newMode);
		},
		[setMode],
	);

	return { isDarkMode, changeTheme, mode: mode || DEFAULT_MODE };
};
