import { useCallback } from "react";
import { useNavigate } from "react-router";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { Logger } from "~/core/shared/logger";
import { useCreateTrunk as useCreate } from "~/trunks/services/trunks.service";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import type { Schema } from "./create-trunk.schema";

export const useCreateTrunk = () => {
  /** Retrieves the current workspace ID for building navigation paths. */
  const workspaceId = useWorkspaceId();

  /** Hook to programmatically navigate between pages. */
  const navigate = useNavigate();

  /**
   * Handler for navigating back to the workspace trunks page.
   * Uses view transitions for smoother page transitions (if supported).
   */
  const onGoBack = useCallback(() => {
    navigate(`/workspaces/${workspaceId}/sip-network/trunks`, {
      viewTransition: true
    });
  }, [navigate, workspaceId]);

  /** Custom hook to create a trunk via API with optimistic updates. */
  const { mutateAsync, isPending } = useCreate();

  /**
   * Handler called after form submission.
   * Submits the data, shows a toast, and navigates back to the trunks page.
   *
   * @param {Schema} data - The validated form data from the form component.
   */
  const onSave = useCallback(
    async (data: Schema, disableNavigation?: boolean) => {
      try {
        Logger.debug("Creating trunk with data:", data);
        const trunks = await mutateAsync({ sendRegister: true, ...data });
        toast("Trunk created successfully!");

        if (disableNavigation) return trunks;

        onGoBack();

        return trunks;
      } catch (error) {
        toast(getErrorMessage(error));
      }
    },
    [mutateAsync, onGoBack]
  );

  /**
   * Renders the Create Trunk page layout.
   */
  return {
    onGoBack,
    onSave,
    isPending
  };
};
