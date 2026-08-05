import { Avatar, IconButton, Box } from "@mui/material";
import React from "react";
import { Icon } from "../../design-system/icons/icons";
import { Tooltip } from "../../design-system/ui/tooltip/tooltip";

export const HeaderNotificationsButton: React.FC = () => {
  return (
    <Box display="flex" alignItems="center" gap={2}>
      {/* Avatar */}
      <Tooltip title="This feature is coming soon!">
        <IconButton
          sx={{
            width: 32,
            height: 32,
            p: 0,
            borderRadius: "50%",
            transition: "all 0.2s ease-in-out",

            "&:hover .MuiAvatar-root": {
              bgcolor: "brand.07",
              color: "brand.03"
            }
          }}
        >
          <Avatar
            sx={{
              width: 32,
              height: 32,
              fontSize: 16,
              fontWeight: 700,
              bgcolor: "brand.03",
              color: "brand.07",
              transition: "all 0.2s ease-in-out"
            }}
          >
            <Icon name="NotificationsActive" fontSize="inherit" />
          </Avatar>
        </IconButton>
      </Tooltip>
    </Box>
  );
};
