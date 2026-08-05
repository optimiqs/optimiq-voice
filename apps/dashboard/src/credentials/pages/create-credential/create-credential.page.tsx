import { Box } from "@mui/material";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { FormProvider } from "~/core/contexts/form-context";
import { CreateCredentialForm } from "./create-credential.form";
import { useCreateCredential } from "./create-credential.hook";
import type { Route } from "./+types/create-credential.page";

/**
 * Page metadata for the "Create Credential" page.
 *
 * Sets the page title and description for SEO and browser tabs.
 *
 * @param _ - Meta arguments provided by the router (not used here).
 * @returns An array of metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
  return [
    { title: "Credentials | Optimiq Voice" },
    {
      name: "description",
      content:
        "Credentials are used to authenticate SIP Agents and Trunks within your network."
    }
  ];
}

/**
 * CreateCredential component.
 *
 * Page component for creating a new voice credential.
 * Includes:
 *  - Page header with navigation and actions.
 *  - Form for entering credential details.
 *  - Save action to submit the form.
 *
 * @returns {JSX.Element} The rendered Create Credential page.
 */
export default function CreateCredential() {
  /** Custom hook to create a credential via API with optimistic updates. */
  const { onGoBack, onSave } = useCreateCredential();

  /**
   * Renders the Create Credential page layout.
   */
  return (
    <FormProvider>
      <Page variant="form">
        <PageHeader
          title="Create New Credentials"
          description="Credentials are used to authenticate SIP Agents and Trunks within your network."
          onBack={{ label: "Back to credentials", onClick: onGoBack }}
          actions={
            <FormSubmitButton size="small" loadingText="Saving...">
              Save Credential
            </FormSubmitButton>
          }
        />

        {/* Form container with a max width for readability and consistent layout */}
        <Box sx={{ maxWidth: "440px" }}>
          <CreateCredentialForm onSubmit={onSave} />
        </Box>
      </Page>
    </FormProvider>
  );
}
