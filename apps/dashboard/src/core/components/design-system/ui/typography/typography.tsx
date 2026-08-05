import {
  Typography as PrimitiveTypography,
  type TypographyPropsVariantOverrides,
  type TypographyVariant
} from "@mui/material";
import { type OverridableStringUnion } from "@mui/types";
import { VARIANT_MAPPING, type TypographyProps } from "./typography.variants";

export function Typography(props: TypographyProps) {
  const {
    variant = "body-medium",
    children,
    sx,
    style: inlineStyles,
    color = "inherit",
    ...rest
  } = props;

  const { variant: mui, style } = VARIANT_MAPPING[variant];

  return (
    <PrimitiveTypography
      {...rest}
      sx={sx}
      variant={
        mui as OverridableStringUnion<
          TypographyVariant | "inherit",
          TypographyPropsVariantOverrides
        >
      }
      style={{ ...style, ...inlineStyles }}
      color={color}
    >
      {children}
    </PrimitiveTypography>
  );
}
