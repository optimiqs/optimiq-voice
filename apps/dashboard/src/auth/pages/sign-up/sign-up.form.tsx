import { zodResolver } from "@hookform/resolvers/zod";
import { Box } from "@mui/material";
import { useCallback, useState, useEffect } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { AgreeTermsModal } from "~/auth/components/agree-terms-modal";
import {
  Form,
  FormControl,
  FormField,
  FormItem
} from "~/core/components/design-system/forms";
import { FormRoot } from "~/core/components/design-system/forms/form-root";
import { Checkbox } from "~/core/components/design-system/ui/checkbox/checkbox";
import { Input } from "~/core/components/design-system/ui/input/input";
import { PasswordStrengthBar } from "~/core/components/design-system/ui/password-strength-bar";
import { SignupFormActions } from "./sign-up.actions";
import type { Schema } from "./sign-up.page";

export interface SignupFormProps extends React.PropsWithChildren {
  form: UseFormReturn<Schema>;
  onSubmit: (data: Schema, form: UseFormReturn<Schema>) => Promise<void>;
  onGithubAuth: () => Promise<void>;
}

export function SignupForm({ form, onSubmit, onGithubAuth }: SignupFormProps) {
  const [isAgreeTermsModalOpen, setIsAgreeTermsModalOpen] = useState(false);

  const onFormSubmit = useCallback((data: Schema) => onSubmit(data, form), []);

  const watchAgreeToTerms = form.watch("agreeToTerms");
  const watchPassword = form.watch("password");

  useEffect(() => {
    if (watchAgreeToTerms) {
      setIsAgreeTermsModalOpen(true);
    }
  }, [watchAgreeToTerms]);

  return (
    <>
      <Form {...form}>
        <FormRoot onSubmit={form.handleSubmit(onFormSubmit)}>
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    type="text"
                    label="Name"
                    supportingText="Please enter your name"
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
                    supportingText="Please confirm your password"
                    {...field}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="agreeToTerms"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Box textAlign="center">
                    <Checkbox {...field}>
                      Agree to the terms and conditions
                    </Checkbox>
                  </Box>
                </FormControl>
              </FormItem>
            )}
          />

          <SignupFormActions {...{ form, onGithubAuth }} />
        </FormRoot>
      </Form>
      <AgreeTermsModal
        isOpen={isAgreeTermsModalOpen}
        setIsOpen={setIsAgreeTermsModalOpen}
      />
    </>
  );
}
