import CloseIcon from "@mui/icons-material/Close";
import { IconButton, Stack, Typography, useTheme } from "@mui/material";
import { toast as sonner } from "sonner";

export interface ToastProps {
	id: number | string;
	message: string;
	variant?: "error" | "default";
}

export const Toast = ({ id, message, variant }: ToastProps) => {
	const theme = useTheme();

	return (
		<Stack
			direction="row"
			alignItems="center"
			justifyContent="space-between"
			spacing={2}
			sx={{
				width: "100%",
				py: 1,
				px: 2,
				borderRadius: 1,
				color: theme.palette.brand["07"],
			}}
		>
			<Typography
				variant="body2"
				sx={{
					fontSize: 12,
					letterSpacing: "0.12px",
					lineHeight: "normal",
					fontWeight: 400,
				}}
			>
				{message}
			</Typography>
			<IconButton
				size="small"
				onClick={() => sonner.dismiss(id)}
				aria-label="Close notification"
				color="inherit"
			>
				<CloseIcon fontSize="medium" color="inherit" />
			</IconButton>
		</Stack>
	);
};
