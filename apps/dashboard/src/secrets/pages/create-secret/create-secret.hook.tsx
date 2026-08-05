import { useCallback } from "react";
import { useNavigate } from "react-router";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useCreateSecret as useCreate } from "~/secrets/services/secrets.service";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import type { Schema } from "./create-secret.schema";

export const useCreateSecret = () => {
  /** Retrieves the current workspace ID for building navigation paths. */
  const workspaceId = useWorkspaceId();

  /** Hook to programmatically navigate between pages. */
  const navigate = useNavigate();

  /**
   * Handler for navigating back to the workspace secrets page.
   * Uses view transitions for smoother page transitions (if supported).
   */
  const onGoBack = useCallback(() => {
    navigate(`/workspaces/${workspaceId}/secrets`, {
      viewTransition: true
    });
  }, [navigate, workspaceId]);

  /** Custom hook to create a secret via API with optimistic updates. */
  const { mutate, isPending } = useCreate();

  /**
   * Handler called after form submission.
   * Submits the data, shows a toast, and navigates back to the secrets page.
   *
   * @param {Schema} data - The validated form data from the form component.
   */
  const onSave = useCallback(
    async (data: Schema) => {
      try {
        mutate({ ...data });
        toast("Secret created successfully!");
        onGoBack();
      } catch (error) {
        toast(getErrorMessage(error));
      }
    },
    [mutate, onGoBack]
  );

  /**
   * Renders the Create Secret page layout.
   */
  return {
    onGoBack,
    onSave,
    isPending
  };
};
