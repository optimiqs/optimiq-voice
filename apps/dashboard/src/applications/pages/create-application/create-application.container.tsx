import { Box } from "@mui/material";
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useApplicationTestCall } from "~/applications/hooks/use-test-call";
import { useCreateApplication } from "~/applications/services/applications.service";
import { formatApplicationData } from "~/applications/services/format-application-data";
import { useApplicationContext } from "~/applications/stores/application.store";
import { Icon } from "~/core/components/design-system/icons/icons";
import { Button } from "~/core/components/design-system/ui/button/button";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { Tooltip } from "~/core/components/design-system/ui/tooltip/tooltip";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import { CreateApplicationForm } from "./create-application.form";
import type { Form, Schema } from "./schemas/application-schema";

export function CreateApplicationContainer() {
  /** The current workspace ID from route or context */
  const workspaceId = useWorkspaceId();

  /** Navigation handler */
  const navigate = useNavigate();

  /** API hook to create a new application */
  const { mutateAsync } = useCreateApplication();

  /** Access application context state */
  const { application, setApplication } = useApplicationContext();

  /** Handles navigation back to the list of applications */
  const onGoBack = useCallback(() => {
    navigate(`/workspaces/${workspaceId}/applications`, {
      viewTransition: true
    });
  }, [navigate, workspaceId]);

  /**
   * Handle successful form submission.
   * Formats and sends data to backend, updates context and UI state.
   *
   * @param data - Validated application schema
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

        const { ref } = await mutateAsync(formattedData);

        setApplication({ ref });
        toast("Application created successfully!");

        // Navigate to edit page to prevent accidental duplicates and allow further configuration
        navigate(`/workspaces/${workspaceId}/applications/${ref}/edit`, {
          viewTransition: true
        });
      } catch (error) {
        toast(getErrorMessage(error));
      }
    },
    [mutateAsync, setApplication, navigate, workspaceId]
  );

  /** Hook for managing test call state and SIP stream */
  const { onTestCall, audioRef, isCalling, isLoadingCall, isAnswered, hangup } =
    useApplicationTestCall();

  return (
    <>
      <Page variant="form">
        <PageHeader
          title="Create New Application"
          description="An Application defines how your Voice AI behaves. Use Autopilot for LLM-based agents or External for custom logic."
          onBack={{ label: "Back to voice applications", onClick: onGoBack }}
          actions={
            <Box sx={{ display: "flex", gap: 1, flexDirection: "column" }}>
              {/* Submit application form */}
              <FormSubmitButton size="small" loadingText="Saving...">
                Save Voice Application
              </FormSubmitButton>

              {/* Run SIP test call */}
              <Tooltip
                title={
                  application?.ref
                    ? "Test the application with a call"
                    : "Save the application first to enable test calls"
                }
                placement="left"
              >
                <Button
                  onClick={() => {
                    if (!application?.ref) return;

                    return isAnswered ? hangup() : onTestCall();
                  }}
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
                  {application?.ref
                    ? isCalling && !isAnswered
                      ? "Calling..."
                      : isAnswered
                        ? "Hangup"
                        : "Test Call"
                    : "Save to Test Call"}
                </Button>
              </Tooltip>
            </Box>
          }
        />

        {/* Application creation form */}
        <Box sx={{ maxWidth: "440px" }}>
          <CreateApplicationForm onSubmit={onSave} />
        </Box>
      </Page>

      {/* Audio element to output test call audio via SIP */}
      <audio ref={audioRef} autoPlay />
    </>
  );
}
