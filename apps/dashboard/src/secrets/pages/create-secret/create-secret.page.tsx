import { Box } from "@mui/material";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { FormProvider } from "~/core/contexts/form-context";
import { CreateSecretForm } from "./create-secret.form";
import { useCreateSecret } from "./create-secret.hook";
import type { Route } from "./+types/create-secret.page";

/**
 * Page metadata for the "Create Secret" page.
 *
 * Sets the page title and description for SEO and browser tabs.
 *
 * @param _ - Meta arguments provided by the router (not used here).
 * @returns An array of metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
  return [
    { title: "Secrets | Optimiq Voice" },
    {
      name: "description",
      content:
        "Secrets are encrypted variables available to your apps and APIs within the current workspace."
    }
  ];
}

/**
 * CreateSecret component.
 *
 * Page component for creating a new voice secret.
 * Includes:
 *  - Page header with navigation and actions.
 *  - Form for entering secret details.
 *  - Save action to submit the form.
 *
 * @returns {JSX.Element} The rendered Create Secret page.
 */
export default function CreateSecret() {
  /** Custom hook to create a secret via API with optimistic updates. */
  const { onGoBack, onSave } = useCreateSecret();

  /**
   * Renders the Create Secret page layout.
   */
  return (
    <FormProvider>
      <Page variant="form">
        <PageHeader
          title="Create New Secret"
          description="Secrets are encrypted variables available to your apps and APIs within the current workspace."
          onBack={{ label: "Back to secrets", onClick: onGoBack }}
          actions={
            <FormSubmitButton size="small" loadingText="Saving...">
              Save Secret
            </FormSubmitButton>
          }
        />

        {/* Form container with a max width for readability and consistent layout */}
        <Box sx={{ maxWidth: "440px" }}>
          <CreateSecretForm onSubmit={onSave} />
        </Box>
      </Page>
    </FormProvider>
  );
}
