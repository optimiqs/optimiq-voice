import { Box } from "@mui/material";
import React from "react";
import { Checkbox } from "~/core/components/design-system/ui/checkbox/checkbox";

/**
 * Props interface for the JsonPreviewToggle component.
 */
interface JsonPreviewToggleProps {
  /**
   * Indicates whether the checkbox is currently checked.
   */
  checked: boolean;

  /**
   * Callback function to handle checkbox state changes.
   *
   * @param checked - The new checked state.
   */
  onChange: (checked: boolean) => void;

  /**
   * Disables the checkbox if true, preventing user interaction.
   */
  disabled: boolean;
}

/**
 * JsonPreviewToggle component.
 *
 * Renders a checkbox that allows users to toggle the JSON preview display
 * in a parent form or component.
 *
 * Integrates:
 * - MUI's Box component for layout.
 * - A reusable Checkbox component from the design system.
 *
 * @param {JsonPreviewToggleProps} props - Props including checked state, onChange handler, and disabled flag.
 * @returns {JSX.Element} The rendered JSON preview toggle.
 */
export const JsonPreviewToggle: React.FC<JsonPreviewToggleProps> = ({
  checked,
  onChange,
  disabled
}) => (
  <Box>
    <Checkbox
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
    >
      Show preview (JSON only)
    </Checkbox>
  </Box>
);
