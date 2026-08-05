import { InputAdornment, FormHelperText, InputLabel } from "@mui/material";
import { forwardRef, type ReactNode } from "react";
import { useFormField } from "../../forms";
import {
  TextareaInput,
  TextareaRoot,
  TextareaFormControl
} from "./textarea.styles";

export interface TextareaProps {
  label?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  supportingText?: string;
  size?: "small" | "medium";
  minRows?: number;
  maxRows?: number;
  maxLength?: number;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      label,
      leadingIcon,
      trailingIcon,
      supportingText,
      size = "medium",
      minRows = 3,
      maxRows,
      maxLength,
      ...rest
    },
    ref
  ) => {
    const { error } = useFormField();

    return (
      <TextareaFormControl fullWidth error={Boolean(error)}>
        {label && (
          <InputLabel
            shrink
            className="MuiFormLabel-root MuiInputLabel-root MuiInputLabel-shrink"
          >
            {label}
          </InputLabel>
        )}

        <TextareaRoot size={size}>
          {leadingIcon && (
            <InputAdornment position="start">{leadingIcon}</InputAdornment>
          )}
          <TextareaInput
            ref={ref}
            minRows={minRows}
            maxRows={maxRows}
            maxLength={maxLength}
            style={{
              maxHeight: maxRows ? `${maxRows * 1.5}em` : undefined
            }}
            {...rest}
          />
          {trailingIcon && (
            <InputAdornment position="end">{trailingIcon}</InputAdornment>
          )}
        </TextareaRoot>

        <FormHelperText className="MuiFormHelperText-root">
          {error ? error.message : supportingText}
        </FormHelperText>
      </TextareaFormControl>
    );
  }
);

Textarea.displayName = "Textarea";
