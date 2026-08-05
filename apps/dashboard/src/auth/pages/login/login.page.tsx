import { Box } from "@mui/material";
import { useCallback } from "react";
import { useSubmit } from "react-router";
import { getGithubSigninUrl } from "~/auth/config/oauth";
import { Typography } from "~/core/components/design-system/ui/typography/typography";
import { LoginForm, type Schema } from "./login.form";
import type { Route } from "./+types/login.page";

/**
 * Sets the metadata for the login page.
 * Used by the router to set the document title and other meta tags.
 *
 * @param _ - Meta arguments (unused in this case).
 * @returns Array of meta objects for the page.
 */
export function meta(_: Route.MetaArgs) {
  return [{ title: "Log In | Optimiq Voice" }];
}

/** Re-exports the action function for form submission handling. */
export { action } from "./login.action";

/**
 * LoginPage component.
 * Renders the main layout for the login page including:
 *  - Page title
 *  - Login form with email/password
 *  - GitHub login button (currently a placeholder)
 *
 * Integrates React Hook Form for validation and react-router submit for form handling.
 */
export default function LoginPage() {
  /** react-router hook to submit form data using the `post` method. */
  const submit = useSubmit();

  /**
   * Memoized submit handler for the login form.
   * Uses react-router's `submit` to trigger the action defined for the route.
   *
   * @param data - The validated form data.
   */
  const onSubmit = useCallback(
    (data: Schema) => submit(data, { method: "post", viewTransition: true }),
    [submit]
  );

  /**
   * Handler for GitHub authentication (currently not implemented).
   * Displays a toast message as a placeholder.
   */
  const onGithubAuth = useCallback(async () => {
    window.location.href = getGithubSigninUrl();
  }, []);

  return (
    <Box
      width="100%"
      maxWidth="440px"
      gap="40px"
      display="flex"
      flexDirection="column"
    >
      {/* Page title */}
      <Typography
        variant="heading-large"
        color="base.03"
        sx={{ textAlign: "center" }}
      >
        Sign In
      </Typography>

      {/* Login form */}
      <LoginForm {...{ onSubmit, onGithubAuth }} />
    </Box>
  );
}
