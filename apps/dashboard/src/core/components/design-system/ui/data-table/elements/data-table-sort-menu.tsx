import { Menu, MenuItem, IconButton, ListItemText } from "@mui/material";
import React, { useCallback, useState } from "react";
import { Icon } from "../../../icons/icons";
import type { SortOrder } from "../data-table.interfaces";
import type { Column } from "@tanstack/react-table";

interface SortMenuProps<TData, TValue> {
  onSortChange: (order: SortOrder) => void;
  column: Column<TData, TValue>;
}

const SORT_OPTIONS = [
  { label: "Ascending Order", value: "asc" },
  { label: "Descending Order", value: "desc" }
];

export const SortMenu: React.FC<SortMenuProps<any, any>> = ({
  onSortChange,
  column
}) => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = useCallback(() => setAnchorEl(null), []);

  const handleSelect = useCallback(
    (order: SortOrder) => {
      onSortChange(order);
      handleClose();
    },
    [onSortChange, handleClose]
  );

  return (
    <>
      <IconButton onClick={handleOpen} sx={{ padding: 0, fontSize: "12px" }}>
        {column.getIsSorted() === "asc" ? (
          <Icon name="KeyboardArrowUpIcon" fontSize="inherit" />
        ) : column.getIsSorted() === "desc" ? (
          <Icon name="KeyboardArrowDownIcon" fontSize="inherit" />
        ) : (
          <Icon name="UnfoldMore" fontSize="inherit" />
        )}
      </IconButton>

      <Menu
        anchorEl={anchorEl}
        open={!!anchorEl}
        onClose={handleClose}
        slotProps={{
          paper: {
            sx: (theme) => ({
              padding: "0px",
              borderRadius: "4px",
              boxShadow: "0px 5px 10px 0px rgba(0, 0, 0, 0.10)",
              borderRight: `1px solid ${theme.palette.base["06"]}`,
              borderBottom: `1px solid ${theme.palette.base["06"]}`,
              backgroundColor: theme.palette.bg.surface
            })
          }
        }}
      >
        {SORT_OPTIONS.map((option) => (
          <MenuItem
            key={option.value}
            sx={(theme) => ({
              padding: "4px 8px",
              borderBottom: `1px solid ${theme.palette.base["06"]}`,
              "&:last-child": {
                borderBottom: "none"
              },
              "&:hover": {
                backgroundColor: theme.palette.base["07"]
              }
            })}
            onClick={() => handleSelect(option.value as SortOrder)}
          >
            <ListItemText
              slotProps={{
                primary: {
                  sx: (theme) => ({
                    fontSize: "10px",
                    fontWeight: 500,
                    color: theme.palette.base["03"],
                    fontFeatureSettings: "'liga' off, 'clig' off",
                    fontFamily: "Poppins",
                    lineHeight: "normal",
                    fontStyle: "normal"
                  })
                }
              }}
            >
              {option.label}
            </ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
};
