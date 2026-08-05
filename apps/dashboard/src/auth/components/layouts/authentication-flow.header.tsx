import { styled } from "@mui/material";
import { memo } from "react";
import { Logo } from "~/core/components/design-system/ui/logo/logo";

export const AuthenticationFlowHeader = memo(() => {
	return (
		<HeaderRoot>
			<Logo />
		</HeaderRoot>
	);
});

export const HeaderRoot = styled("div")(({ theme }) => ({
	minHeight: "75px",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	padding: "24px 40px",
	width: "100%",
	borderBottom: `1px solid ${theme.palette.base["06"]}`,
}));
