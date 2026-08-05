import { useFormContext } from "~/core/contexts/form-context";
import { Button } from "../button/button";
import type { ButtonAttributes } from "../button/button.styles";

export interface FormSubmitButtonProps extends Omit<
  ButtonAttributes,
  "onClick" | "disabled"
> {
  children?: React.ReactNode;
  loadingText?: string;
  disabledText?: string;
  /**
   * When false, the button will not require the form to be dirty to enable submission.
   * Defaults to true to preserve current behavior.
   */
  requireDirty?: boolean;
}

export function FormSubmitButton({
  children = "Save",
  loadingText = "Saving...",
  disabledText,
  requireDirty = true,
  ...buttonProps
}: FormSubmitButtonProps) {
  const { formState, submitForm } = useFormContext();

  // Disable if form is invalid, submitting, has errors, or has no changes
  const isDisabled =
    !formState.isValid ||
    formState.isSubmitting ||
    formState.hasErrors ||
    (requireDirty && !formState.isDirty);

  const buttonText = formState.isSubmitting
    ? loadingText
    : isDisabled && disabledText
      ? disabledText
      : children;

  return (
    <Button {...buttonProps} onClick={submitForm} disabled={isDisabled}>
      {buttonText}
    </Button>
  );
}
