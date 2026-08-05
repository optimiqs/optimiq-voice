import { Box } from "@mui/material";
import { useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useResetPassword } from "~/auth/services/auth.service";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { Typography } from "~/core/components/design-system/ui/typography/typography";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { Logger } from "~/core/shared/logger";
import {
  ResetPasswordForm,
  type Form,
  type Schema
} from "./reset-password.form";
import type { Route } from "./+types/reset-password.page";

export interface ResetPasswordTokenPayload {
  username: string;
  code: string;
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Reset Password | Optimiq Voice" }];
}

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const token = searchParams.get("token");

  const { mutateAsync } = useResetPassword();

  useEffect(() => {
    if (!token) {
      toast("Token is missing. Please check the link you clicked.");
      navigate("/auth/login", { replace: true });
    }
  }, [token, setSearchParams]);

  const onSubmit = useCallback(async ({ password }: Schema, form: Form) => {
    if (!token) {
      toast("Token is missing. Please check the link you clicked.");
      return;
    }

    try {
      const payload = JSON.parse(atob(token)) as ResetPasswordTokenPayload;

      if (
        Object.keys(payload).length !== 2 ||
        !payload.username ||
        !payload.code
      ) {
        toast("Invalid token format. Please check the link you clicked.");
        return;
      }

      const { username, code: verificationCode } = payload;

      await mutateAsync({ username, verificationCode, password });
      toast("Password reset successfully! You can now log in.");
      navigate("/auth/login", { replace: true });
    } catch (error) {
      Logger.error("[ResetPasswordPage] Error resetting password", error);
      toast(getErrorMessage(error));

      form.reset();
    }
  }, []);

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
          Reset your password
        </Typography>
        <Typography variant="body-small" color="base.03">
          Please reset your password using 8+ characters with upper, lower,
          number, and symbol.
        </Typography>
      </Box>
      <ResetPasswordForm onSubmit={onSubmit} />
    </Box>
  );
}
