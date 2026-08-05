import { Box } from "@mui/material";
import { useCallback, useLayoutEffect } from "react";
import { useNavigate, useSearchParams, useSubmit } from "react-router";
import { Button } from "~/core/components/design-system/ui/button/button";
import { Logo } from "~/core/components/design-system/ui/logo/logo";
import { Typography } from "~/core/components/design-system/ui/typography/typography";
import { Splash } from "~/core/components/general/splash/splash";
import { useOptimiqVoice } from "~/core/sdk/hooks/use-optimiq-voice";

/** Exports the logout action, which handles the server-side logout process. */
export { action } from "./logout.action";

/**
 * Logout page component.
 *
 * Handles the client-side and server-side logout processes:
 * - Calls the logout function from the Optimiq Voice SDK to clear tokens.
 * - Submits a POST request to the server to destroy the session.
 * - Shows a splash screen while the logout is in progress.
 *
 * @returns {JSX.Element} The rendered logout page.
 */
export default function Logout() {
  /** Retrieves the current URL search parameters from react-router. */
  const [searchParams] = useSearchParams();

  /**
   * Determines if the logout was triggered automatically.
   * If 'auto_logout' is set to "true" in the query string, logout starts immediately.
   */
  const isConfirmed = searchParams.get("auto_logout") === "true";

  /** Hook to navigate programmatically between pages. */
  const navigate = useNavigate();

  /** Hook to submit a POST request for the server-side logout action. */
  const submit = useSubmit();

  /** Custom hook to access Optimiq Voice SDK's logout method for clearing tokens. */
  const { logout } = useOptimiqVoice();

  /**
   * Handles the logout process:
   * - Clears the client-side session using the SDK.
   * - Submits a POST request to trigger the server-side logout.
   */
  const onLogout = useCallback(() => {
    logout();
    submit(null, { method: "post" });
  }, [logout, submit]);

  /**
   * Automatically triggers logout if 'auto_logout' is set to true in the query string.
   *
   * useLayoutEffect is used to synchronize the logout action
   * before the browser paints, ensuring a smooth experience without flickering.
   */
  useLayoutEffect(() => {
    if (isConfirmed) {
      onLogout();
    }
  }, [isConfirmed, onLogout]);

  /**
   * If logout is confirmed and in progress, show a splash screen.
   */
  if (isConfirmed) {
    return <Splash message="We are logging you out... Please wait :(" />;
  }

  /**
   * Otherwise, render a confirmation screen asking the user to confirm logout.
   */
  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100dvh",
        flexDirection: "column",
        gap: 2,
        padding: 2,
        backgroundColor: "bg.app",
        textAlign: "center"
      }}
    >
      {/* Company or app logo */}
      <Logo />

      {/* Logout confirmation message */}
      <Typography variant="body-small" color="base.03">
        Are you sure you want to log out?
      </Typography>

      {/* Action buttons: confirm or cancel */}
      <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
        <Button onClick={onLogout} size="small">
          Yes, log me out
        </Button>
        <Button variant="outlined" size="small" onClick={() => navigate("/")}>
          No, take me back
        </Button>
      </Box>
    </Box>
  );
}
