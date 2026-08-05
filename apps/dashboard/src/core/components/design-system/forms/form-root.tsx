import { styled } from "@mui/material";
import { memo } from "react";

export const FormRoot = memo(function FormRoot({
  onSubmit,
  children
}: React.HTMLProps<HTMLFormElement>) {
  return (
    <FormRootElement autoComplete="off" noValidate onSubmit={onSubmit}>
      {children}
    </FormRootElement>
  );
});

FormRoot.displayName = "FormRoot";

export const FormRootElement = styled("form")(() => ({
  gap: "24px",
  display: "flex",
  flexDirection: "column"
}));
