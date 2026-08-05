import { Box, styled } from "@mui/material";
import { type UseFormReturn } from "react-hook-form";
import { Button } from "~/core/components/design-system/ui/button/button";
import { Divider } from "~/core/components/design-system/ui/divider/divider";
import { Typography } from "~/core/components/design-system/ui/typography/typography";
import { Link } from "~/core/components/general/link/link";
import type { Schema } from "./sign-up.page";

export interface SignupFormActionsProps extends React.PropsWithChildren {
	form: UseFormReturn<Schema>;
	onGithubAuth: () => Promise<void>;
}

export function SignupFormActions({ form, onGithubAuth }: SignupFormActionsProps) {
	const { isValid, isSubmitting } = form.formState;
	const isSubmitDisabled = !isValid || isSubmitting;

	return (
		<LoginFormRoot>
			<Button type="submit" isFullWidth disabled={isSubmitDisabled}>
				{isSubmitting ? "Loading..." : "Sign up for Optimiq Voice"}
			</Button>

			<Divider />

			<Button isFullWidth variant="outlined" disabled={isSubmitting} onClick={onGithubAuth}>
				Sign Up with GitHub
			</Button>

			<Typography variant="body-small" color="base.03">
				Already have an account? <Link to="/auth/login">Sign In</Link>
			</Typography>
		</LoginFormRoot>
	);
}

export const LoginFormRoot = styled(Box)(({ theme }) => ({
	display: "flex",
	flexDirection: "column",
	gap: theme.spacing(2),
	textAlign: "center",
	marginTop: theme.spacing(2),
}));
