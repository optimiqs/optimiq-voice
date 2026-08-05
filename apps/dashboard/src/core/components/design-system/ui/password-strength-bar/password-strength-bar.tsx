import { Box, styled } from "@mui/material";
import { Typography } from "../typography/typography";
import {
  assessPasswordStrength,
  getPasswordStrengthScore,
  getPasswordStrengthColor
} from "./password-strength.helper";

export interface PasswordStrengthBarProps {
  password: string;
  showLabel?: boolean;
  height?: number;
  width?: string | number;
}

const ProgressBarContainer = styled(Box)(({ theme }) => ({
  width: "100%",
  backgroundColor: theme.palette.base["07"],
  borderRadius: theme.spacing(0.5),
  overflow: "hidden",
  position: "relative",
  border: `1px solid ${theme.palette.base["06"]}`
}));

const ProgressBarFill = styled(Box)<{ $score: number; $color: string }>(
  ({ $score, $color }) => ({
    height: "100%",
    width: `${$score}%`,
    backgroundColor: $color,
    transition: "width 0.3s ease-in-out, background-color 0.3s ease-in-out",
    borderRadius: "inherit"
  })
);

export function PasswordStrengthBar({
  password,
  showLabel = true,
  height = 6,
  width = "50%"
}: PasswordStrengthBarProps) {
  const strength = assessPasswordStrength(password);
  const score = getPasswordStrengthScore(password);
  const color = getPasswordStrengthColor(strength);

  if (!password) return null;

  return (
    <Box
      sx={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}
    >
      <Box sx={{ width, my: 1 }}>
        <ProgressBarContainer sx={{ height }}>
          <ProgressBarFill $score={score} $color={color} />
        </ProgressBarContainer>

        {showLabel && (
          <Box
            sx={{
              mt: 0.5,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center"
            }}
          >
            <Typography variant="body-micro" sx={{ color: "text.secondary" }}>
              Password strength
            </Typography>
            <Typography
              variant="body-micro"
              sx={{
                color: color,
                fontWeight: 500,
                textTransform: "capitalize"
              }}
            >
              {strength}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
