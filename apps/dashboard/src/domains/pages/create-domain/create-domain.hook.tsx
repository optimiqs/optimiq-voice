import { useCallback } from "react";
import { useNavigate } from "react-router";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useCreateDomain as useCreate } from "~/domains/services/domains.service";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import type { Schema } from "./create-domain.schema";

export const useCreateDomain = () => {
  /** Retrieves the current workspace ID for building navigation paths. */
  const workspaceId = useWorkspaceId();

  /** Hook to programmatically navigate between pages. */
  const navigate = useNavigate();

  /**
   * Handler for navigating back to the workspace domains page.
   * Uses view transitions for smoother page transitions (if supported).
   */
  const onGoBack = useCallback(() => {
    navigate(`/workspaces/${workspaceId}/sip-network/domains`, {
      viewTransition: true
    });
  }, [navigate, workspaceId]);

  /** Custom hook to create a domain via API with optimistic updates. */
  const { mutateAsync, isPending } = useCreate();

  /**
   * Handler called after form submission.
   * Submits the data, shows a toast, and navigates back to the domains page.
   *
   * @param {Schema} data - The validated form data from the form component.
   */
  const onSave = useCallback(
    async (data: Schema) => {
      try {
        await mutateAsync({ ...data });
        toast("Domain created successfully!");
        onGoBack();
      } catch (error) {
        toast(getErrorMessage(error));
      }
    },
    [mutateAsync, onGoBack]
  );

  /**
   * Renders the Create Domain page layout.
   */
  return {
    onGoBack,
    onSave,
    isPending
  };
};
