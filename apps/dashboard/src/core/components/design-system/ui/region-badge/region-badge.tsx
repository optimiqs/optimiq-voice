import { Box } from "@mui/material";
import {
  DrawerRegionBadge,
  LandingPageRegionBadge
} from "./region-badge.styles";

export const RegionBadge = ({
  children,
  type = "landing-page"
}: {
  children: string;
  type?: "landing-page" | "drawer";
}) => {
  const Wrapper =
    type === "landing-page" ? LandingPageRegionBadge : DrawerRegionBadge;

  return (
    <Wrapper>
      <Box
        sx={{
          display: "flex",
          height: "16px",
          flexDirection: "column",
          justifyContent: "center"
        }}
      >
        {children}
      </Box>
    </Wrapper>
  );
};
