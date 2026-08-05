import { type SelectProps as MUISelectProps, type FormControlProps } from "@mui/material";
import { type ReactNode } from "react";

export interface SelectOption {
	value: string | number;
	label: string;
}

export type SelectProps = MUISelectProps & {
	label?: string;
	supportingText?: string;
	leadingIcon?: ReactNode;
	trailingIcon?: ReactNode;
	options: SelectOption[];
	onChange?: (event: { target: { value: string | number | Array<string | number> } }) => void;
	placeholder?: string;
	allowClear?: boolean;
};

export type SelectContainerProps = FormControlProps & {
	label?: string;
	supportingText?: string;
	error?: boolean;
	children: ReactNode;
};

export type SelectInputProps = MUISelectProps & {
	options: SelectOption[];
	leadingIcon?: ReactNode;
	trailingIcon?: ReactNode;
};

export interface MultiValueRendererProps {
	selected: Array<string | number>;
	options: SelectOption[];
	onDelete: (val: string | number) => void;
}
