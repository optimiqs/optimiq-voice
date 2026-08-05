import { Icon } from "../../icons/icons";
import { Typography } from "../typography/typography";
import { GoBackRoot } from "./go-back.styles";

export interface LinkBackToProps {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}

export const GoBackButton = ({
  onClick,
  label,
  disabled = false
}: LinkBackToProps) => {
  return (
    <GoBackRoot
      onClick={disabled ? undefined : onClick}
      className={disabled ? "disabled" : ""}
      role="button"
      aria-disabled={disabled}
    >
      <Icon
        name="ChevronLeft"
        sx={{
          fontSize: "18px !important",
          color: "inherit"
        }}
      />
      <Typography variant="body-small">{label}</Typography>
    </GoBackRoot>
  );
};
