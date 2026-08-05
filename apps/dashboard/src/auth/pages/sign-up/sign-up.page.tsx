import { zodResolver } from "@hookform/resolvers/zod";
import { Box } from "@mui/material";
import { useCallback, useLayoutEffect } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { useNavigate, useSubmit } from "react-router";
import { z } from "zod";
import { getGithubSignupUrl } from "~/auth/config/oauth";
import { useCreateUser } from "~/auth/services/auth.service";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { Typography } from "~/core/components/design-system/ui/typography/typography";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { IS_CLOUD, IS_SIGNUP_ENABLED } from "~/core/sdk/stores/optimiq-voice.config";
import { Logger } from "~/core/shared/logger";
import { SignupForm } from "./sign-up.form";
import type { Route } from "./+types/sign-up.page";

export { action } from "../login/login.action";

export function meta(_: Route.MetaArgs) {
	return [{ title: "Sign Up | Optimiq Voice" }];
}

export const schema = z.object({
	name: z.string().nonempty(),
	email: z.string().email(),
	password: z.string().min(8, "Password must be at least 8 characters"),
	confirmPassword: z.string(),
	agreeToTerms: z.boolean().refine((val) => val === true, {
		message: "You must agree to the terms and conditions",
	}),
});

export const resolver = zodResolver(schema);

export type Schema = z.infer<typeof schema>;
export type Form = UseFormReturn<Schema>;
const SIGNUP_DISABLED_MESSAGE = "Signup is currently limited to private beta invites.";

export default function SignupPage() {
	const navigate = useNavigate();

	const form = useForm<Schema>({
		resolver,
		defaultValues: {
			name: "",
			email: "",
			password: "",
			confirmPassword: "",
			agreeToTerms: false,
		},
		mode: "onChange",
	});

	const submit = useSubmit();
	const { mutateAsync: createUser } = useCreateUser();

	const onSubmit = useCallback(
		async ({ confirmPassword, password, ...data }: Schema, form: Form) => {
			Logger.debug("[SignupPage] onSubmit called with data:", data);
			try {
				if (!IS_SIGNUP_ENABLED) {
					toast(SIGNUP_DISABLED_MESSAGE);
					navigate("/auth/login", { replace: true });
					return;
				}

				if (password !== confirmPassword) {
					Logger.debug("[SignupPage] Passwords do not match");
					form.setError("confirmPassword", {
						type: "manual",
						message: "Passwords do not match",
					});
					return;
				}

				await createUser({ ...data, password });
				toast("User created successfully");

				Logger.debug("[SignupPage] User created successfully, redirecting");

				await submit({ ...data, password }, { method: "post", viewTransition: true });
			} catch (error) {
				Logger.error("[SignupPage] Error creating user:", error);
				toast(getErrorMessage(error));
			}
			Logger.debug("[SignupPage] Form submitted successfully");
		},
		[createUser, navigate, submit],
	);

	const onGithubAuth = useCallback(async () => {
		if (!IS_SIGNUP_ENABLED) {
			toast(SIGNUP_DISABLED_MESSAGE);
			navigate("/auth/login", { replace: true });
			return;
		}

		window.location.href = getGithubSignupUrl();
	}, [navigate]);

	useLayoutEffect(() => {
		if (!IS_CLOUD) {
			navigate("/auth/login", { replace: true });
			return;
		}

		if (!IS_SIGNUP_ENABLED) {
			toast(SIGNUP_DISABLED_MESSAGE);
			navigate("/auth/login", { replace: true });
		}
	}, [navigate]);

	return (
		<Box width="100%" maxWidth="440px" gap="40px" display="flex" flexDirection="column">
			<Typography variant="heading-large" color="base.03" sx={{ textAlign: "center" }}>
				Sign up for Optimiq Voice
			</Typography>
			<SignupForm {...{ form, onSubmit, onGithubAuth }} />
		</Box>
	);
}
