import { Tooltip as MuiTooltip, tooltipClasses, styled } from "@mui/material";

export const TooltipRoot = styled(MuiTooltip)(({ theme }) => ({
  [`& .${tooltipClasses.tooltip}`]: {
    backgroundColor: theme.palette.base["03"],
    color: theme.palette.base["08"],
    fontSize: 10,
    padding: "10px",
    borderRadius: 4,
    boxShadow: "none",
    maxWidth: 300,
    fontStyle: "normal",
    fontWeight: 500,
    lineHeight: "normal"
  },
  [`& .${tooltipClasses.arrow}`]: {
    color: theme.palette.base["03"]
  }
}));
