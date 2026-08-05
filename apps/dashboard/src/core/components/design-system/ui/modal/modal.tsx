import CloseIcon from "@mui/icons-material/Close";
import { IconButton, useTheme } from "@mui/material";
import { ModalRoot, ModalContent, ModalTitle } from "./modal.styles";
import type { ReactNode } from "react";

export interface ModalProps {
	open: boolean;
	onClose: () => void;
	title?: string;
	children: ReactNode;
	maxWidth?: "xs" | "sm" | "md" | "lg" | "xl";
	hideCloseButton?: boolean;
}

export const Modal = ({
	open,
	onClose,
	title,
	children,
	maxWidth = "xs",
	hideCloseButton = false,
}: ModalProps) => {
	const theme = useTheme();

	return (
		<ModalRoot open={open} onClose={onClose} fullWidth maxWidth={maxWidth}>
			{title && (
				<ModalTitle>
					{title}
					{!hideCloseButton && (
						<IconButton
							onClick={onClose}
							aria-label="Close modal"
							size="medium"
							sx={{ color: theme.palette.base["02"] }}
						>
							<CloseIcon fontSize="medium" color="inherit" />
						</IconButton>
					)}
				</ModalTitle>
			)}
			<ModalContent sx={{ overflowY: "auto", pt: "6px !important" }}>{children}</ModalContent>
		</ModalRoot>
	);
};

Modal.displayName = "Modal";
