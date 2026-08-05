import { CheckboxRoot } from "./checkbox-root";
import { type CheckboxProps, CheckboxLabel } from "./checkbox.styles";

export const Checkbox = (props: CheckboxProps) => {
  const { children, ...checkboxProps } = props;

  if (children === undefined) {
    return <CheckboxRoot {...checkboxProps} />;
  }

  return (
    <CheckboxLabel
      control={<CheckboxRoot {...checkboxProps} />}
      label={children}
    />
  );
};
