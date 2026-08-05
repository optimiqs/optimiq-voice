import { Stack, styled } from "@mui/material";

export const HeaderRoot = styled("header")(({ theme }) => ({
  position: "relative",
  minHeight: "75px",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  padding: "24px 40px",
  width: "100%",
  borderBottom: `1px solid ${theme.palette.base["06"]}`,
  backgroundColor: theme.palette.bg.app,
  ...theme.applyStyles("dark", {
    backgroundColor: theme.palette.bg.app
  })
}));

export const HeaderContent = styled(Stack)(({ theme }) => ({
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  width: "100%",
  height: "100%",
  backgroundColor: theme.palette.bg.app,
  ...theme.applyStyles("dark", {
    backgroundColor: theme.palette.bg.app
  })
}));
