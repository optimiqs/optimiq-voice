import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { InputAdornment, IconButton, type TextFieldProps } from "@mui/material";
import { forwardRef, type ReactNode, useCallback, useState } from "react";
import { toast } from "../toaster/toaster";
import { Tooltip } from "../tooltip/tooltip";
import { InputRoot } from "./input.styles";

export interface InputTextProps extends Omit<TextFieldProps, "size"> {
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  supportingText?: string;
  size?: "small" | "medium";
  showCopyIcon?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputTextProps>(
  (
    {
      leadingIcon,
      trailingIcon,
      supportingText,
      size = "medium",
      showCopyIcon = true,
      slotProps,
      value,
      ...rest
    },
    ref
  ) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(async () => {
      try {
        await navigator.clipboard.writeText(String(value));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (error) {
        toast("Failed to copy to clipboard", { variant: "error" });
      }
    }, [value]);

    return (
      <InputRoot
        {...rest}
        ref={ref}
        variant="outlined"
        fullWidth
        helperText={supportingText}
        size={size}
        value={value}
        sx={{ opacity: 0.8 }}
        InputProps={{
          readOnly: true,
          startAdornment: leadingIcon ? (
            <InputAdornment position="start">{leadingIcon}</InputAdornment>
          ) : undefined,
          endAdornment: (
            <InputAdornment position="end" sx={{ right: "16px" }}>
              {trailingIcon}
              {showCopyIcon && (
                <Tooltip title={copied ? "¡Copied!" : "Copy to clipboard"}>
                  <IconButton
                    aria-label="Copy to clipboard"
                    onClick={handleCopy}
                    edge="end"
                  >
                    <ContentCopyIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </InputAdornment>
          )
        }}
        slotProps={{
          inputLabel: { shrink: true },
          ...slotProps
        }}
      />
    );
  }
);

Input.displayName = "Input";
