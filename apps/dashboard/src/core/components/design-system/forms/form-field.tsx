import {
  Controller,
  type ControllerProps,
  type FieldPath,
  type FieldValues
} from "react-hook-form";
import { FormFieldContext } from "./form.context";

/**
 * Form Field
 *
 * @description A form field is a form element controller that provides the necessary
 * context for the form element to be accessible.
 */
export function FormField<
  Values extends FieldValues = FieldValues,
  Name extends FieldPath<Values> = FieldPath<Values>
>({ ...props }: ControllerProps<Values, Name>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}
