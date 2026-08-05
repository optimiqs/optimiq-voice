import { styled } from "@mui/material";
import { forwardRef, useId } from "react";
import { FormItemContext } from "./form.context";

/**
 * Form Item
 *
 * @description A form item is a component that provides the necessary context
 * for the form elements within it to be accessible.
 */
export const FormItem = forwardRef<
  HTMLFieldSetElement,
  React.HTMLAttributes<HTMLFieldSetElement>
>((props, ref) => {
  const id = useId();

  return (
    <FormItemContext.Provider value={{ id }}>
      <FormItemRoot role="group" {...{ ...props, ref, id }} />
    </FormItemContext.Provider>
  );
});

FormItem.displayName = "FormItem";

export const FormItemRoot = styled("fieldset")(() => ({
  display: "flex",
  flexDirection: "column",
  padding: 0,
  margin: 0,
  border: "none"
}));
