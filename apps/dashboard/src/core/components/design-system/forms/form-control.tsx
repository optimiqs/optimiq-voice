import {
  type ComponentPropsWithoutRef,
  type ComponentRef,
  forwardRef
} from "react";
import { useFormField } from "./form.context";

export interface FormControlProps extends ComponentPropsWithoutRef<"div"> {
  isError?: boolean;
}

/**
 * Form Control
 *
 * @description A form control is a component that wraps a form element and provides
 * the necessary attributes and context for the form element to be accessible.
 */
const FormControl = forwardRef<ComponentRef<"div">, FormControlProps>(
  ({ ...props }, ref) => {
    const { error, formItemId, formHelpId, formMessageId } = useFormField();

    return (
      <div
        ref={ref}
        id={formItemId}
        aria-describedby={
          !error ? formHelpId : `${formHelpId} ${formMessageId}`
        }
        aria-invalid={Boolean(error)}
        data-state={error ? "invalid" : "valid"}
        {...props}
      />
    );
  }
);

FormControl.displayName = "FormControl";

export { FormControl };
