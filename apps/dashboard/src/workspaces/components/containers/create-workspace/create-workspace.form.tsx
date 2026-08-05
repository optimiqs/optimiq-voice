import { zodResolver } from "@hookform/resolvers/zod";
import { Box, styled } from "@mui/material";
import { useCallback } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem
} from "~/core/components/design-system/forms";
import { FormRoot } from "~/core/components/design-system/forms/form-root";
import { Button } from "~/core/components/design-system/ui/button/button";
import { Input } from "~/core/components/design-system/ui/input/input";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useOptimiqVoice } from "~/core/sdk/hooks/use-optimiq-voice";
import { useCreateWorkspace } from "~/workspaces/services/workspaces.service";

/**
 * Zod schema for form validation.
 * Defines the expected shape of the workspace form data.
 */
export const schema = z.object({
  name: z.string().nonempty()
});

/** Resolver for react-hook-form using zod */
export const resolver = zodResolver(schema);

/** Type inferred from the zod schema */
export type Schema = z.infer<typeof schema>;

/**
 * Props for the CreateWorkspaceForm component.
 *
 * @property {function} [onFormSubmit] - Optional callback executed after successful form submission.
 */
export interface CreateWorkspaceFormProps extends React.PropsWithChildren {
  onFormSubmit?: (data: Schema) => void;
}

/**
 * CreateWorkspaceForm component
 *
 * Renders a form to create a new workspace, including validation,
 * submission, and feedback via toasts.
 *
 * @param {CreateWorkspaceFormProps} props - Props including optional onFormSubmit handler.
 * @returns {JSX.Element} The rendered form.
 */
export function CreateWorkspaceForm({
  onFormSubmit
}: CreateWorkspaceFormProps) {
  const { client } = useOptimiqVoice();

  /** Hook to create a new workspace via API */
  const { mutateAsync, isPending } = useCreateWorkspace();

  /** Initializes the react-hook-form instance with validation resolver and default values */
  const form = useForm<Schema>({
    resolver,
    defaultValues: {
      name: ""
    },
    mode: "onChange"
  });

  /**
   * Form submission handler.
   * Calls the mutate function, shows a toast, resets the form,
   * and optionally invokes the onFormSubmit callback.
   *
   * @param {Schema} data - The validated form data.
   */
  const onSubmit = useCallback(
    async (data: Schema) => {
      try {
        await mutateAsync(data);

        // Refresh JWT claims so newly created workspace permissions are available immediately.
        await client.loginWithRefreshToken(client.getRefreshToken());

        toast("Ahoy! Workspace created successfully");
        form.reset();

        if (onFormSubmit) {
          onFormSubmit(data);
        }
      } catch (error) {
        toast(getErrorMessage(error));
      }
    },
    [client, form, mutateAsync, onFormSubmit]
  );

  /** Extracts form state for disabling the submit button when needed */
  const { isValid, isSubmitting } = form.formState;
  const isSubmitDisabled = !isValid || isSubmitting || isPending;

  /**
   * Renders the form, including an input field for the workspace name
   * and a submit button that is disabled while submitting or when the form is invalid.
   */
  return (
    <Form {...form}>
      <FormRoot onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Input
                  type="text"
                  label="Name"
                  supportingText="Enter a name for your workspace"
                  {...field}
                />
              </FormControl>
            </FormItem>
          )}
        />

        <ActionsRoot>
          <Button type="submit" disabled={isSubmitDisabled}>
            {isSubmitting ? "Loading..." : "Create Workspace"}
          </Button>
        </ActionsRoot>
      </FormRoot>
    </Form>
  );
}

/**
 * Styled component for the container of the form actions.
 * Centers the submit button horizontally and vertically.
 */
export const ActionsRoot = styled(Box)(() => ({
  display: "flex",
  justifyContent: "center",
  alignItems: "center"
}));
