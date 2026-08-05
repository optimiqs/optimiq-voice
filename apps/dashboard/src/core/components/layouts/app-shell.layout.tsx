import { styled } from "@mui/material";
import { Outlet } from "react-router";
import { AppShellSidebar } from "./app-shell.sidebar";

export default function AppShellLayout() {
	return (
		<AppShellContainer>
			<AppShellSidebar />
			<AppShellMain>
				<AppShellMainContent>
					<Outlet />
				</AppShellMainContent>
			</AppShellMain>
		</AppShellContainer>
	);
}

export const AppShellContainer = styled("div")(({ theme }) => ({
	display: "grid",
	gridTemplateColumns: "250px 1fr",
	gridTemplateRows: "1fr",
	width: "100%",
	height: "100%",
	flexGrow: 1,
	overflow: "hidden",
	backgroundColor: theme.palette.bg.surface,
}));

export const AppShellMain = styled("main")(({ theme }) => ({
	display: "flex",
	flexDirection: "column",
	width: "100%",
	height: "100%",
	overflow: "auto",
	backgroundColor: theme.palette.bg.surface,
}));

export const AppShellMainContent = styled("div")(({ theme }) => ({
	display: "flex",
	flexDirection: "column",
	width: "100%",
	backgroundColor: theme.palette.bg.surface,
	height: "100%",
	...theme.applyStyles("dark", {
		backgroundColor: theme.palette.bg.surface,
	}),
}));
