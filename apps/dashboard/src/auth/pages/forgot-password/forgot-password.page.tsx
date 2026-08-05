import { Box } from "@mui/material";
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useForgotPassword } from "~/auth/services/auth.service";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { Typography } from "~/core/components/design-system/ui/typography/typography";
import { OPTIMIQ_VOICE_RESET_PASSWORD_URL } from "~/core/sdk/stores/optimiq-voice.config";
import { Logger } from "~/core/shared/logger";
import {
  ForgotPasswordForm,
  type Form,
  type Schema
} from "./forgot-password.form";
import type { Route } from "./+types/forgot-password.page";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Forgot Password | Optimiq Voice" }];
}

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const { mutateAsync } = useForgotPassword();

  const onSubmit = useCallback(
    async ({ email: username }: Schema, form: Form) => {
      Logger.debug(
        "[<ForgotPasswordPage />]: Submitting forgot password form with data:",
        { username }
      );
      await mutateAsync({
        username,
        resetPasswordUrl: OPTIMIQ_VOICE_RESET_PASSWORD_URL
      });

      toast(
        "Ahoy! If that email is registered, we sent you a link to reset your password. Now check your inbox!"
      );

      form.reset();

      navigate("/auth/login", { replace: true });
    },
    []
  );

  return (
    <Box
      width="100%"
      maxWidth="440px"
      gap="40px"
      display="flex"
      flexDirection="column"
    >
      <Box gap="16px" display="flex" flexDirection="column" textAlign="center">
        <Typography variant="heading-large" color="base.03">
          Forgot Password?
        </Typography>
        <Typography variant="body-small" color="base.03">
          Enter the email associated with your account and we’ll send you a link
          to reset your password.
        </Typography>
      </Box>
      <ForgotPasswordForm onSubmit={onSubmit} />
    </Box>
  );
}
