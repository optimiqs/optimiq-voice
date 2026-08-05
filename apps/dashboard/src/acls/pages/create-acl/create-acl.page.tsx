import { Box } from "@mui/material";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { FormProvider } from "~/core/contexts/form-context";
import { CreateAclForm } from "./create-acl.form";
import { useCreateAcl } from "./create-acl.hook";
import type { Route } from "./+types/create-acl.page";

/**
 * Page metadata for the "Create Acl" page.
 *
 * Sets the page title and description for SEO and browser tabs.
 *
 * @param _ - Meta arguments provided by the router (not used here).
 * @returns An array of metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
  return [
    { title: "Create New ACL | Optimiq Voice" },
    {
      name: "description",
      content:
        "An ACL defines IP-based rules to allow or deny access to your voice infrastructure."
    }
  ];
}

/**
 * CreateAcl component.
 *
 * Page component for creating a new voice acl.
 * Includes:
 *  - Page header with navigation and actions.
 *  - Form for entering acl details.
 *  - Save action to submit the form.
 *
 * @returns {JSX.Element} The rendered Create Acl page.
 */
export default function CreateAcl() {
  /** Custom hook to create a acl via API with optimistic updates. */
  const { onGoBack, onSave } = useCreateAcl();

  /**
   * Renders the Create Acl page layout.
   */
  return (
    <FormProvider>
      <Page variant="form">
        <PageHeader
          title="Create New ACL"
          description="An ACL defines IP-based rules to allow or deny access to your voice infrastructure."
          onBack={{ label: "Back to ACLs", onClick: onGoBack }}
          actions={
            <FormSubmitButton size="small" loadingText="Saving...">
              Save Acl
            </FormSubmitButton>
          }
        />

        {/* Form container with a max width for readability and consistent layout */}
        <Box sx={{ maxWidth: "440px" }}>
          <CreateAclForm
            onSubmit={async (data) => {
              onSave(data);
            }}
          />
        </Box>
      </Page>
    </FormProvider>
  );
}
