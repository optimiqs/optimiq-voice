import { createContext, useContext } from "react";
import { useFormContext } from "react-hook-form";
import type { FieldPath, FieldValues } from "react-hook-form";

export interface FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
> {
  name: TName;
}

export interface FormItemContextValue {
  id: string;
}

export const FormFieldContext = createContext<FormFieldContextValue>({
  name: ""
});

export const FormItemContext = createContext<FormItemContextValue>({
  id: ""
});

/**
 * Form field hook
 *
 * @description This hook is used to get the form field state and the form context.
 */
export const useFormField = () => {
  const { name } = useContext(FormFieldContext);
  const { id } = useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();

  const fieldState = getFieldState(name, formState);

  if (!name) {
    throw new Error("useFormField() should be used within <FormField />");
  }

  return {
    id,
    name,
    formItemId: `${id}-form-item`,
    formHelpId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState
  };
};
