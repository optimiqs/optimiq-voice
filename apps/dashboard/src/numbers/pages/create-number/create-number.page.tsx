import { Box } from "@mui/material";
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { FormProvider } from "~/core/contexts/form-context";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { nonEmptyValues } from "~/core/helpers/remove-empty-values";
import { useCreateNumber } from "~/numbers/services/numbers.service";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import { COUNTRIES } from "./create-number.const";
import { CreateNumberForm, type Schema } from "./create-number.form";
import type { Route } from "./+types/create-number.page";

/**
 * Page metadata for the "Create Number" page.
 *
 * Sets the page title and description for SEO and browser tabs.
 *
 * @param _ - Meta arguments provided by the router (not used here).
 * @returns An array of metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
  return [
    { title: "Numbers | Optimiq Voice" },
    {
      name: "description",
      content:
        "A Number is a PSTN phone number that can be used to make or receive calls."
    }
  ];
}

/**
 * CreateNumber component.
 *
 * Page component for creating a new voice number.
 * Includes:
 *  - Page header with navigation and actions.
 *  - Form for entering number details.
 *  - Save action to submit the form.
 *
 * @returns {JSX.Element} The rendered Create Number page.
 */
export default function CreateNumber() {
  /** Retrieves the current workspace ID for building navigation paths. */
  const workspaceId = useWorkspaceId();

  /** Hook to programmatically navigate between pages. */
  const navigate = useNavigate();

  /**
   * Handler for navigating back to the workspace numbers page.
   * Uses view transitions for smoother page transitions (if supported).
   */
  const onGoBack = useCallback(() => {
    navigate(`/workspaces/${workspaceId}/sip-network/numbers`, {
      viewTransition: true
    });
  }, [navigate, workspaceId]);

  /** Custom hook to create a number via API with optimistic updates. */
  const { mutateAsync } = useCreateNumber();

  /**
   * Handler called after form submission.
   * Submits the data, shows a toast, and navigates back to the numbers page.
   *
   * @param {Schema} data - The validated form data from the form component.
   */
  const onSave = useCallback(
    async ({ country: countryIsoCode, ...data }: Schema) => {
      try {
        const country = COUNTRIES.find(({ value }) => value === countryIsoCode);

        if (!country) {
          toast("Oops! Invalid country selected.");
          return;
        }

        await mutateAsync({
          ...nonEmptyValues(data),
          country: country.label,
          countryIsoCode
        });
        toast("Number created successfully!");
        onGoBack();
      } catch (error) {
        toast(getErrorMessage(error));
      }
    },
    [mutateAsync, onGoBack]
  );

  /**
   * Renders the Create Number page layout.
   */
  return (
    <FormProvider>
      <Page variant="form">
        <PageHeader
          title="Create New Number"
          description="A Number is a PSTN phone number that can be used to make or receive calls."
          onBack={{ label: "Back to numbers", onClick: onGoBack }}
          actions={
            <FormSubmitButton size="small" loadingText="Saving...">
              Save Number
            </FormSubmitButton>
          }
        />

        {/* Form container with a max width for readability and consistent layout */}
        <Box sx={{ maxWidth: "440px" }}>
          <CreateNumberForm onSubmit={onSave} />
        </Box>
      </Page>
    </FormProvider>
  );
}
