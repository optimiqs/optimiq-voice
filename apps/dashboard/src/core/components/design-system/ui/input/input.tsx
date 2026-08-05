import { InputAdornment, type TextFieldProps } from "@mui/material";
import { forwardRef, type ReactNode } from "react";
import { useFormField } from "../../forms";
import { InputRoot } from "./input.styles";

export interface InputTextProps extends Omit<TextFieldProps, "size"> {
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  supportingText?: string;
  size?: "small" | "medium";
}

export const Input = forwardRef<HTMLInputElement, InputTextProps>(
  (
    {
      leadingIcon,
      trailingIcon,
      supportingText,
      size = "medium",
      slotProps,
      ...rest
    },
    ref
  ) => {
    const { error } = useFormField();

    return (
      <InputRoot
        {...rest}
        error={Boolean(error)}
        ref={ref}
        variant="outlined"
        fullWidth
        helperText={error ? error.message : supportingText}
        size={size}
        slotProps={{
          input: {
            startAdornment: leadingIcon ? (
              <InputAdornment position="start">{leadingIcon}</InputAdornment>
            ) : undefined,
            endAdornment: trailingIcon ? (
              <InputAdornment position="end">{trailingIcon}</InputAdornment>
            ) : undefined
          },
          inputLabel: {
            shrink: true
          },
          ...slotProps
        }}
      />
    );
  }
);

Input.displayName = "Input";
