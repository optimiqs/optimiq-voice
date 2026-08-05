import { Box } from "@mui/material";
import { useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { useApplicationTestCall } from "~/applications/hooks/use-test-call";
import {
  useApplication,
  useUpdateApplication
} from "~/applications/services/applications.service";
import { formatApplicationData } from "~/applications/services/format-application-data";
import { useApplicationContext } from "~/applications/stores/application.store";
import { Icon } from "~/core/components/design-system/icons/icons";
import { Button } from "~/core/components/design-system/ui/button/button";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { Splash } from "~/core/components/general/splash/splash";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import { CreateApplicationForm } from "../create-application/create-application.form";
import type {
  Form,
  Schema
} from "../create-application/schemas/application-schema";

export function EditApplicationContainer() {
  /** Workspace context for routing. */
  const workspaceId = useWorkspaceId();

  /** Extract application reference from route. */
  const { ref } = useParams();

  /** Ref is required for fetch and update. Fail early if missing. */
  if (!ref) {
    throw new Error("Application reference is required");
  }

  /** Fetch the application by ref. */
  const { data, isLoading } = useApplication(ref);

  /** Mutation hook for submitting updates. */
  const { mutateAsync } = useUpdateApplication();

  /** Programmatic navigation hook. */
  const navigate = useNavigate();

  /** Application context setter. */
  const { setApplication } = useApplicationContext();

  /** Navigates back to applications list. */
  const onGoBack = useCallback(() => {
    navigate(`/workspaces/${workspaceId}/applications`, {
      viewTransition: true
    });
  }, [navigate, workspaceId]);

  /**
   * Form submission handler for updating application.
   *
   * @param data - Validated schema input from form
   */
  const onSave = useCallback(
    async ({ intelligence, ...data }: Schema, form: Form) => {
      try {
        const formattedData = formatApplicationData(
          { intelligence, ...data },
          form
        );

        if (!formattedData) {
          // If formatApplicationData sets an error, it will return undefined
          return;
        }

        await mutateAsync({ ...formattedData, ref });

        toast("Application updated successfully!");
      } catch (error) {
        console.error(error);
        toast(getErrorMessage(error));
      }
    },
    [mutateAsync, ref]
  );

  /** Set current application context on load. */
  useEffect(() => {
    setApplication({ ref });
  }, [ref]);

  /** Initialize SIP test call logic. */
  const { onTestCall, audioRef, isCalling, isLoadingCall, isAnswered, hangup } =
    useApplicationTestCall();

  /** Show error and redirect if application was not found. */
  useEffect(() => {
    if (!isLoading && !data) {
      toast("Oops! You are trying to edit an application that does not exist.");
      onGoBack();
    }
  }, [isLoading, data, onGoBack]);

  /** Show splash screen during loading. */
  if (isLoading || !data) {
    return <Splash message="Loading application details..." />;
  }

  return (
    <>
      <Page variant="form">
        <PageHeader
          title="Edit Application"
          description="An Application defines how your Voice AI behaves. Use Autopilot for LLM-based agents or External for custom logic."
          onBack={{ label: "Back to voice applications", onClick: onGoBack }}
          actions={
            <Box sx={{ display: "flex", gap: 1, flexDirection: "column" }}>
              {/* Submit button */}
              <FormSubmitButton size="small" loadingText="Saving...">
                Save Voice Application
              </FormSubmitButton>

              {/* Test Call button */}
              <Button
                onClick={isAnswered ? hangup : onTestCall}
                variant="outlined"
                size="small"
                disabled={isLoadingCall || (isCalling && !isAnswered)}
                startIcon={
                  <Icon
                    name="Phone"
                    sx={{ fontSize: "16px !important", color: "inherit" }}
                  />
                }
              >
                {isCalling && !isAnswered
                  ? "Calling..."
                  : isAnswered
                    ? "Hangup"
                    : "Test Call"}
              </Button>
            </Box>
          }
        />

        {/* Application form with initial values */}
        <Box sx={{ maxWidth: "440px" }}>
          <CreateApplicationForm
            onSubmit={onSave}
            initialValues={data as Schema}
            isEdit={true}
          />
        </Box>
      </Page>

      {/* Audio element for SIP test call playback */}
      <audio ref={audioRef} autoPlay />
    </>
  );
}
