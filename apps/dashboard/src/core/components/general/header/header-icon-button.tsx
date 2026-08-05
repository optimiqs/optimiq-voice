import { Avatar, IconButton, Box } from "@mui/material";
import React from "react";

export interface UserAvatarButtonProps {
  initials: string;
  avatar?: string;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
  isMenuOpen?: boolean;
}

export const HeaderIconButton: React.FC<UserAvatarButtonProps> = ({
  initials,
  avatar,
  onClick,
  isMenuOpen = false
}) => (
  <IconButton
    onClick={onClick}
    sx={{
      width: 32,
      height: 32,
      p: 0,
      borderRadius: "50%",
      transition: "all 0.2s ease-in-out",
      position: "relative",

      "&:hover .MuiAvatar-root": {
        bgcolor: "brand.07",
        color: "brand.03"
      }
    }}
  >
    <Box
      sx={{
        position: "relative",
        width: 32,
        height: 32,
        borderRadius: "50%",
        overflow: "hidden"
      }}
    >
      <Avatar
        sx={{
          width: 32,
          height: 32,
          fontSize: 13,
          fontWeight: 700,
          bgcolor: "brand.03",
          color: "brand.07",
          transition: "all 0.2s ease-in-out"
        }}
        src={avatar ? avatar : undefined}
      >
        {initials}
      </Avatar>

      {/* Overlay when menu is open */}
      <Box
        sx={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: "50%",
          backgroundColor: "rgba(0, 0, 0, 0.2)",
          zIndex: 1,
          pointerEvents: "none",
          opacity: isMenuOpen ? 1 : 0,
          transition: "opacity 0.2s ease-in-out"
        }}
      />
    </Box>
  </IconButton>
);
