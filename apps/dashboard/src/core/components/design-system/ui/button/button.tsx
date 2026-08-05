import { StyledButton, type ButtonAttributes } from "./button.styles";

export const Button = ({ isFullWidth, danger, ...props }: ButtonAttributes) => {
	const { size = "large", variant = "contained", ...rest } = props;

	return (
		<StyledButton
			variant={variant}
			size={size}
			disableElevation
			fullWidth={isFullWidth}
			danger={danger}
			{...rest}
		/>
	);
};
