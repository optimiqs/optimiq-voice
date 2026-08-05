import { FormControlLabel } from "@mui/material";
import Checkbox from "@mui/material/Checkbox";
import { styled } from "@mui/material/styles";
import React from "react";
import type { CheckboxProps as MuiCheckboxProps } from "@mui/material/Checkbox";

export interface CheckboxProps extends Omit<
  MuiCheckboxProps,
  "color" | "disableRipple"
> {
  children?: React.ReactNode;
}

export const CheckboxLabel = styled(FormControlLabel)(({ theme }) => ({
  "& .MuiFormControlLabel-label": {
    fontFamily: "Poppins",
    fontFeatureSettings: "'liga' off, 'clig' off",
    fontStyle: "normal",
    fontSize: "12px",
    lineHeight: "normal",
    textDecoration: "underline",
    textDecorationStyle: "solid",
    textDecorationSkipInk: "none",
    textDecorationThickness: "auto",
    textUnderlineOffset: "auto",
    textUnderlinePosition: "from-font",
    color: theme.palette.base["03"]
  }
}));

export const CheckboxRoot = styled(Checkbox)(({ theme }) => ({
  padding: "8px",
  color: theme.palette.base["02"],

  "&.Mui-checked": {
    color: theme.palette.base["02"]
  },

  "&.MuiCheckbox-indeterminate": {
    color: theme.palette.base["02"]
  }
}));
