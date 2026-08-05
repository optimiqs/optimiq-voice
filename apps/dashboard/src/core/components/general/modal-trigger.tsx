import { Box } from "@mui/material";
import { Icon } from "../design-system/icons/icons";
import { Typography } from "../design-system/ui/typography/typography";

/**
 * Props interface for the ModalTrigger component.
 *
 * This component accepts all standard HTML div attributes plus a required label.
 */
export interface ModalTriggerProps extends React.HTMLAttributes<HTMLDivElement> {
	/** Text label displayed next to the icon inside the trigger. */
	label: string;
}

/**
 * ModalTrigger component.
 *
 * Renders a styled, clickable container that serves as a trigger for opening modals.
 * This component includes:
 * - An icon (Add icon).
 * - A text label with underline styling.
 *
 * It uses:
 * - MUI's Box component for layout and styling.
 * - MUI Typography component for consistent text styling.
 * - Custom Icon component for consistent icon usage.
 *
 * Example usage:
 * <ModalTrigger label="Add User" onClick={handleOpenModal} />
 *
 * @param {ModalTriggerProps} props - Props including the label and any HTML div attributes.
 * @returns {JSX.Element} A styled button-like element for triggering a modal.
 */
export const ModalTrigger = ({ label, ...props }: ModalTriggerProps) => {
	return (
		<Box
			component="div"
			role="button"
			{...props}
			sx={{
				display: "flex",
				alignItems: "center",
				gap: "8px",
				cursor: "pointer",
				color: "base.03",
				fontSize: "16px",
				minHeight: "24px",
			}}
		>
			{/* Leading Icon */}
			<Icon name="Add" fontSize="inherit" />

			{/* Label with underline styling */}
			<Typography
				variant="body-micro"
				sx={{
					fontWeight: "400 !important",
					textDecoration: "underline",
					color: "base.03",
				}}
			>
				{label}
			</Typography>
		</Box>
	);
};
