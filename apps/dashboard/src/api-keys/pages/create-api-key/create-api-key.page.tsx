import { Box } from "@mui/material";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { Input } from "~/core/components/design-system/ui/input/input-read-only";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { FormProvider } from "~/core/contexts/form-context";
import { CreateApiKeyForm } from "./create-api-key.form";
import { useCreateApiKey } from "./create-api-key.hook";
import type { Route } from "./+types/create-api-key.page";

/**
 * Page metadata for the "Create ApiKey" page.
 *
 * Sets the page title and description for SEO and browser tabs.
 *
 * @param _ - Meta arguments provided by the router (not used here).
 * @returns An array of metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
  return [
    { title: "API Keys | Optimiq Voice" },
    {
      name: "description",
      content:
        "An API Key is an encrypted token that grants secure access to Optimiq Voice's APIs."
    }
  ];
}

/**
 * CreateApiKey component.
 *
 * Page component for creating a new voice apiKey.
 * Includes:
 *  - Page header with navigation and actions.
 *  - Form for entering apiKey details.
 *  - Save action to submit the form.
 *
 * @returns {JSX.Element} The rendered Create ApiKey page.
 */
export default function CreateApiKey() {
  /** Custom hook to create a apiKey via API with optimistic updates. */
  const { onGoBack, onSave, data } = useCreateApiKey();

  /**
   * Renders the Create ApiKey page layout.
   */
  return (
    <FormProvider>
      <Page variant="form">
        <PageHeader
          title="Create New API Key"
          description="An API Key is an encrypted token that grants secure access to Optimiq Voice's APIs."
          onBack={{ label: "Back to API Keys", onClick: onGoBack }}
          actions={
            <FormSubmitButton
              size="small"
              loadingText="Saving..."
              requireDirty={false}
            >
              Save API Key
            </FormSubmitButton>
          }
        />

        {/* Form container with a max width for readability and consistent layout */}
        <Box
          sx={{
            maxWidth: "440px",
            gap: "24px",
            display: "flex",
            flexDirection: "column"
          }}
        >
          <CreateApiKeyForm onSubmit={onSave} />

          {/* Display success message if API Key was created successfully */}
          {data && (
            <Box sx={{ display: "flex", flexDirection: "column", gap: "24px" }}>
              <Input label="Access Key ID" value={data.accessKeyId} disabled />
              <Input
                label="Secret Access Key"
                value={data.accessKeySecret}
                disabled
              />
            </Box>
          )}
        </Box>
      </Page>
    </FormProvider>
  );
}
