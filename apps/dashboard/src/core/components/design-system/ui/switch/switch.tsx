import { useCallback, useEffect, useState } from "react";
import { SwitchRoot } from "./switch.styles";

export interface SwitchProps {
  defaultValue?: boolean;
  value?: boolean;
  disabled?: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

export const Switch = (props: SwitchProps) => {
  const { defaultValue, value, disabled, onChange } = props;

  const [isChecked, setIsChecked] = useState(value ?? defaultValue);

  useEffect(() => {
    setIsChecked(value ?? defaultValue);
  }, [value, defaultValue]);

  const onChangeEvent = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setIsChecked(event.target.checked);

      if (onChange) {
        onChange(event);
      }
    },
    [onChange]
  );

  return (
    <SwitchRoot
      checked={isChecked}
      disabled={disabled}
      onChange={onChangeEvent}
    />
  );
};
