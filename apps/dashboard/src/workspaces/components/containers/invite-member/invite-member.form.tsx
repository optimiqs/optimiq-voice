import { zodResolver } from "@hookform/resolvers/zod";
import { Box, styled } from "@mui/material";
import { useCallback } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Role } from "@optimiq-voice/types";
import {
  Form,
  FormControl,
  FormField,
  FormItem
} from "~/core/components/design-system/forms";
import { FormRoot } from "~/core/components/design-system/forms/form-root";
import { Button } from "~/core/components/design-system/ui/button/button";
import { Input } from "~/core/components/design-system/ui/input/input";
import { Select } from "~/core/components/design-system/ui/select/select";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { Logger } from "~/core/shared/logger";
import { useInviteWorkspace } from "~/workspaces/services/workspaces.service";
import { ROLE_OPTIONS } from "./invite-member-roles.const";

export const schema = z.object({
  role: z.nativeEnum(Role),
  name: z
    .string()
    .min(1, { message: "Name is required" })
    .max(100, { message: "Name must be less than 100 characters" }),
  email: z.string().email()
});

export const resolver = zodResolver(schema);

export type Schema = z.infer<typeof schema>;

export interface InviteMemberFormProps extends React.PropsWithChildren {
  onClose?: () => void;
}

export function InviteMemberForm({ onClose }: InviteMemberFormProps) {
  const form = useForm<Schema>({
    resolver,
    defaultValues: {
      name: "",
      email: "",
      role: Role.WORKSPACE_MEMBER
    },
    mode: "onChange"
  });

  const { mutateAsync } = useInviteWorkspace();

  const onSubmit = useCallback(
    async (data: Schema) => {
      try {
        await mutateAsync(data);
        toast(
          "Member invited successfully. Ask them to check their email for the invitation link."
        );
        form.reset();

        if (onClose) {
          onClose();
        }
      } catch (error) {
        Logger.error("Failed to invite member", error);
        toast(getErrorMessage(error));
      }
    },
    [form]
  );

  const { isValid, isSubmitting } = form.formState;
  const isSubmitDisabled = !isValid || isSubmitting;

  return (
    <Form {...form}>
      <FormRoot onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="role"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Select label="Role" options={ROLE_OPTIONS} {...field} />
              </FormControl>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Input
                  type="text"
                  label="Name"
                  supportingText="Please enter your full name"
                  {...field}
                />
              </FormControl>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Input
                  type="email"
                  label="Email Address"
                  supportingText="Please enter your email address"
                  {...field}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <ActionsRoot>
          <Button type="submit" disabled={isSubmitDisabled}>
            {isSubmitting ? "Loading..." : "Invite Member"}
          </Button>
        </ActionsRoot>
      </FormRoot>
    </Form>
  );
}

export const ActionsRoot = styled(Box)(() => ({
  display: "flex",
  justifyContent: "center",
  alignItems: "center"
}));
