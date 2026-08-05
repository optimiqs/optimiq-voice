import { useTheme } from "@mui/material";
import Portal from "@mui/material/Portal";
import { memo } from "react";
import { Toaster as Sonner, toast as sonner } from "sonner";
import { Toast } from "./toaster.styles";

export interface ToastOptions {
	duration?: number;
	variant?: "error" | "default";
}

export const Toaster = memo(() => {
	const theme = useTheme();

	return (
		<Portal>
			<Sonner
				position="top-center"
				toastOptions={{
					className: "mui-toast",
					style: {
						boxShadow: "0px 4px 8px 3px rgba(0, 0, 0, 0.15), 0px 1px 3px 0px rgba(0, 0, 0, 0.30)",
						padding: 0,
						border: "none",
						borderRadius: "4px",
						backgroundColor: theme.palette.brand["03"],
					},
				}}
			/>
		</Portal>
	);
});

export const toast = (
	message: string,
	{ duration = 3000, variant = "default" }: ToastOptions = {},
) => {
	const id = `toast__${Date.now().toString()}-${Math.random().toString()}`;

	sonner(<Toast {...{ message, id, variant }} />, { id, duration });
};

Toaster.displayName = "Toaster";
