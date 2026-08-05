import { Box } from "@mui/material";
import { useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { Splash } from "~/core/components/general/splash/splash";
import { FormProvider } from "~/core/contexts/form-context";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useSecret, useUpdateSecret } from "~/secrets/services/secrets.service";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import { CreateSecretForm } from "../create-secret/create-secret.form";
import type { Schema } from "../create-secret/create-secret.schema";
import type { Route } from "./+types/edit-secret.page";

/**
 * Sets the metadata for the "Edit Secret" page.
 *
 * This information is used by the router to define the page title and description
 * for SEO and display in the browser.
 *
 * @param _ - Meta arguments provided by the router (unused here).
 * @returns {Array} Metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
  return [
    { title: "Secrets | Optimiq Voice" },
    {
      name: "description",
      content: "Edit a secret to protect your domains, peers, and trunks."
    }
  ];
}

/**
 * EditSecret page component.
 *
 * Renders a page to edit an existing voice secret, including:
 * - Page header with back navigation and save button.
 * - A form pre-filled with the secret details.
 * - Data fetching and optimistic update integration.
 *
 * @returns {JSX.Element} The rendered Edit Secret page.
 */
export default function EditSecret() {
  /** Retrieves the current workspace ID for building navigation paths. */
  const workspaceId = useWorkspaceId();

  /** Extracts the secret reference from the URL parameters. */
  const { ref } = useParams();

  /**
   * Ensures the secret reference is provided.
   *
   * This value should never be null or undefined, as it is required
   * to fetch and update the secret data.
   */
  if (!ref) {
    throw new Error("Secret reference is required");
  }

  /** Fetches the existing secret details for editing. */
  const { data, isLoading } = useSecret(ref);

  /** Hook to programmatically navigate between pages. */
  const navigate = useNavigate();

  /**
   * Handler for navigating back to the secrets page.
   * Uses `viewTransition` for smoother transitions.
   */
  const onGoBack = useCallback(() => {
    navigate(`/workspaces/${workspaceId}/secrets`, {
      viewTransition: true
    });
  }, [navigate, workspaceId]);

  /** Custom hook to handle secret updates via the API. */
  const { mutate } = useUpdateSecret();

  /**
   * Handler called after form submission.
   * Updates the secret, shows a toast, and navigates back to the secrets page.
   *
   * @param {Schema} data - The validated form data.
   */
  const onSave = useCallback(
    async (data: Schema) => {
      try {
        mutate({ ...data, ref });
        toast("Secret updated successfully!");
        onGoBack();
      } catch (error) {
        toast(getErrorMessage(error));
      }
    },
    [mutate, ref, onGoBack]
  );

  /**
   * Effect that ensures the user is redirected if the secret does not exist.
   * Shows an error toast and navigates back to the secrets page.
   */
  useEffect(() => {
    if (!isLoading && !data) {
      toast("Oops! You are trying to edit a secret that does not exist.");
      onGoBack();
    }
  }, [isLoading, data, onGoBack]);

  /**
   * Shows a loading indicator while fetching the secret data.
   */
  if (isLoading || !data) {
    return <Splash message="Loading secret details..." />;
  }

  /**
   * Renders the Edit Secret page layout.
   */
  return (
    <FormProvider>
      <Page variant="form">
        <PageHeader
          title="Edit Secret"
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
          <CreateSecretForm
            onSubmit={onSave}
            initialValues={{ ...data, type: "text" }}
            isEdit={true}
          />
        </Box>
      </Page>
    </FormProvider>
  );
}
