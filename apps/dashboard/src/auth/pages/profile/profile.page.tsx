import { Box } from "@mui/material";
import { useNavigate } from "react-router";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { FormProvider } from "~/core/contexts/form-context";
import { PersonalSettingsForm } from "./profile.form";
import type { Route } from "./+types/profile.page";

/**
 * Page metadata function.
 *
 * Sets the page title for SEO and browser tab.
 *
 * @param {Route.MetaArgs} _ - Meta args provided by the route loader.
 * @returns {Array} An array containing the page title.
 */
export function meta(_: Route.MetaArgs) {
  return [{ title: "Personal Settings | Optimiq Voice" }];
}

/**
 * Profile component (Personal Settings Page).
 *
 * Renders the personal settings form, allowing users to modify
 * their profile information and save changes. Includes a back navigation
 * button and a submit button in the header.
 *
 * @returns {JSX.Element} The rendered personal settings page.
 */
export default function Profile() {
  const navigate = useNavigate();

  const onGoBack = () => {
    navigate("/");
  };

  /**
   * Renders the personal settings page with a header and profile form.
   */
  return (
    <FormProvider>
      <Page>
        <PageHeader
          title="Personal Settings"
          description="Update your personal information and account settings."
          onBack={{ label: "Back to dashboard", onClick: onGoBack }}
          actions={
            <FormSubmitButton size="small" loadingText="Saving...">
              Save Changes
            </FormSubmitButton>
          }
        />

        <Box sx={{ maxWidth: "440px" }}>
          <PersonalSettingsForm />
        </Box>
      </Page>
    </FormProvider>
  );
}
