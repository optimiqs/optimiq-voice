import { memo } from "react";
import { Icon } from "../../icons/icons";
import { type CheckboxProps, CheckboxRoot as Primitive } from "./checkbox.styles";

export const CheckboxRoot = memo((props: CheckboxProps) => {
	return (
		<Primitive
			icon={<Icon name="CheckboxEmpty" fontSize="small" />}
			checkedIcon={<Icon name="CheckboxSelected" fontSize="small" />}
			indeterminateIcon={<Icon name="CheckboxIntermediate" fontSize="small" />}
			disableRipple
			{...props}
		/>
	);
});

CheckboxRoot.displayName = "CheckboxRoot";
