import { Box, Stack } from "@mui/material";
import { memo } from "react";
import { Logo } from "../../design-system/ui/logo/logo";
import { Link } from "../link/link";
import { HeaderRoot, HeaderContent } from "./header.styles";
import { HeaderNotificationsButton } from "./notifications";
import { UserAccountPopover } from "./user-account-options";

export const Header = memo(() => {
	return (
		<HeaderRoot>
			<HeaderContent>
				<Box sx={{ display: "flex", alignItems: "center" }}>
					<Link to="/" style={{ lineHeight: "0" }}>
						<Logo />
					</Link>
				</Box>
				<Stack
					direction="row"
					spacing={1}
					sx={{
						alignItems: "center",
						flex: "1 1 auto",
						justifyContent: "flex-end",
					}}
				>
					<HeaderNotificationsButton />
					<UserAccountPopover />
				</Stack>
			</HeaderContent>
		</HeaderRoot>
	);
});
