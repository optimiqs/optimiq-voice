import { zodResolver } from "@hookform/resolvers/zod";
import { Box, styled } from "@mui/material";
import { useCallback } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
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
import { PasswordStrengthBar } from "~/core/components/design-system/ui/password-strength-bar";
import { Typography } from "~/core/components/design-system/ui/typography/typography";
import { Link } from "~/core/components/general/link/link";

export const schema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string().nonempty()
});

export const resolver = zodResolver(schema);
export type Schema = z.infer<typeof schema>;
export type Form = UseFormReturn<Schema>;

export interface ResetPasswordFormProps extends React.PropsWithChildren {
  onSubmit: (data: Schema, form: Form) => Promise<void>;
}

export function ResetPasswordForm({ onSubmit }: ResetPasswordFormProps) {
  const form = useForm<Schema>({
    resolver,
    defaultValues: {
      password: "",
      confirmPassword: ""
    },
    mode: "onChange"
  });

  const watchPassword = form.watch("password");

  const onSubmitForm = useCallback(
    async (data: Schema) => {
      if (data.password !== data.confirmPassword) {
        form.setError("confirmPassword", {
          type: "manual",
          message: "Passwords do not match"
        });
        return;
      }

      return await onSubmit(data, form);
    },
    [onSubmit, form]
  );

  const { isValid, isSubmitting } = form.formState;
  const isSubmitDisabled = !isValid || isSubmitting;

  return (
    <Form {...form}>
      <FormRoot onSubmit={form.handleSubmit(onSubmitForm)}>
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Input type="password" label="Password" {...field} />
                <PasswordStrengthBar password={watchPassword} />
              </FormControl>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Input
                  type="password"
                  label="Confirm Password"
                  supportingText="Please confirm your new password"
                  {...field}
                />
              </FormControl>
            </FormItem>
          )}
        />

        <ActionsRoot>
          <Button type="submit" isFullWidth disabled={isSubmitDisabled}>
            {isSubmitting ? "Loading..." : "Reset Password"}
          </Button>

          <Link to="/auth/login">
            <Typography variant="body-small" color="base.03">
              Back to Sign In
            </Typography>
          </Link>
        </ActionsRoot>
      </FormRoot>
    </Form>
  );
}

export const ActionsRoot = styled(Box)(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  gap: theme.spacing(2),
  textAlign: "center",
  marginTop: theme.spacing(2)
}));
