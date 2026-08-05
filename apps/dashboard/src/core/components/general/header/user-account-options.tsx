import { Menu, MenuItem, Box, ListItemText } from "@mui/material";
import React, { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "~/auth/hooks/use-auth";
import { Typography } from "../../design-system/ui/typography/typography";
import { HeaderIconButton } from "./header-icon-button";
import { getInitials } from "./header-random-avatar.helper";

export const UserAccountPopover: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const handleOpen = useCallback(
    (event: React.MouseEvent<HTMLElement>) => setAnchorEl(event.currentTarget),
    []
  );

  const handleClose = useCallback(() => setAnchorEl(null), []);

  const handleNavigate = (path: string) => {
    handleClose();
    navigate(path);
  };

  return (
    <Box display="flex" alignItems="center" gap={2}>
      <HeaderIconButton
        initials={getInitials(user.name)}
        avatar={user.avatar}
        onClick={handleOpen}
        isMenuOpen={open}
      />

      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: {
              padding: 0,
              minWidth: 232,
              mt: 1.5,
              borderRadius: 0,
              boxShadow: "0 4px 20px rgba(0, 0, 0, 0.05)"
            }
          }
        }}
      >
        <Box sx={{ p: "10px", display: "flex", alignItems: "center" }}>
          <Typography variant="body-medium">Account</Typography>
        </Box>

        <MenuItem
          sx={{ padding: "10px !important" }}
          onClick={() => handleNavigate("/accounts/profile")}
        >
          <ListItemText
            primary={
              <Typography variant="body-small">Account Settings</Typography>
            }
          />
        </MenuItem>

        <MenuItem
          sx={{ padding: "10px !important" }}
          onClick={() => handleNavigate("/auth/logout?auto_logout=true")}
        >
          <ListItemText
            primary={
              <Typography variant="body-small-underline">Sign Out</Typography>
            }
          />
        </MenuItem>
      </Menu>
    </Box>
  );
};
