import { Box } from "@mui/material";
import { useState, useCallback } from "react";
import { useNavigate } from "react-router";
import { ContactType } from "@optimiq-voice/types";
import { useCurrentUser } from "~/auth/hooks/use-current-user";
import { useUpdateUser } from "~/auth/services/auth.service";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { Typography } from "~/core/components/design-system/ui/typography/typography";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useOptimiqVoice } from "~/core/sdk/hooks/use-optimiq-voice";
import StepProgress from "./step-progress";
import { VerificationFlowEmail } from "./verification-flow-email.form";
import { VerificationFlowPhoneCode } from "./verification-flow-phone-code.form";
import { VerificationFlowPhone } from "./verification-flow-phone.form";
import type { Route } from "./+types/verification-flow.page";

export function meta(_: Route.MetaArgs) {
	return [{ title: "Verify Account | Optimiq Voice" }];
}

export default function VerificationFlow() {
	const steps = ["Verify email address", "Enter phone number", "Verify phone number"];
	const [activeStep, setActiveStep] = useState(0);
	const [phoneNumber, setPhoneNumber] = useState("");
	const [isComplete, setIsComplete] = useState(false);
	const { client } = useOptimiqVoice();
	const { user, userId } = useCurrentUser();
	const { mutateAsync: updateUser } = useUpdateUser();

	const [emailTimer, setEmailTimer] = useState(0);
	const [phoneTimer, setPhoneTimer] = useState(0);

	const startTimer = useCallback((setTimer: React.Dispatch<React.SetStateAction<number>>) => {
		setTimer(30);
		const interval = setInterval(() => {
			setTimer((prev: number) => {
				if (prev <= 1) {
					clearInterval(interval);
					return 0;
				}
				return prev - 1;
			});
		}, 1000);
	}, []);

	const handleNext = () => setActiveStep((prev) => Math.min(prev + 1, steps.length - 1));

	const handleResendEmail = async () => {
		if (!user?.email) return;

		try {
			await client.sendVerificationCode(ContactType.EMAIL, user.email);
			toast("Verification code sent to your email");
			startTimer(setEmailTimer);
		} catch (e) {
			toast(getErrorMessage(e));
		}
	};

	const handlePhoneSubmit = async (data: { phoneNumber: string }) => {
		try {
			await updateUser({ ref: userId, phone: data.phoneNumber });
			await client.sendVerificationCode(ContactType.PHONE, data.phoneNumber);
			setPhoneNumber(data.phoneNumber);
			toast("Code sent to your phone");
			handleNext();
		} catch (e) {
			toast(getErrorMessage(e));
		}
	};

	const handlePhoneCodeSubmit = async (data: { code: string }) => {
		try {
			if (!user) {
				throw new Error("User not found");
			}

			await client.verifyCode({
				username: user.email,
				contactType: ContactType.PHONE,
				value: phoneNumber,
				verificationCode: data.code,
			});
			setIsComplete(true);
			toast("Phone verified! Redirecting...");
			setTimeout(() => {
				// Redirect to home after verification
				window.location.href = "/";
			}, 400);
		} catch (e) {
			toast(getErrorMessage(e));
		}
	};

	const handleResendPhone = async () => {
		if (!phoneNumber) return;

		try {
			await client.sendVerificationCode(ContactType.PHONE, phoneNumber);
			toast("Verification code sent to your phone");
			startTimer(setPhoneTimer);
		} catch (e) {
			toast("Error sending code to phone");
		}
	};

	const emailResendSlot = (
		<div style={{ textAlign: "center" }}>
			Didn’t receive the code?{" "}
			{emailTimer > 0 ? (
				<span style={{ color: "#888" }}>Send again in {emailTimer} seconds</span>
			) : (
				<a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={handleResendEmail}>
					Send again
				</a>
			)}
		</div>
	);

	const phoneResendSlot = (
		<div style={{ textAlign: "center" }}>
			Didn’t receive the code?{" "}
			{phoneTimer > 0 ? (
				<span style={{ color: "#888" }}>Send again in {phoneTimer} seconds</span>
			) : (
				<a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={handleResendPhone}>
					Send again
				</a>
			)}
		</div>
	);

	return (
		<Box
			sx={{
				width: "100%",
				maxWidth: "670px",
				margin: "0 auto",
				display: "flex",
				flexDirection: "column",
				gap: "48px",
				flexGrow: 1,
				paddingY: "40px",
				alignItems: "center",
			}}
		>
			<StepProgress steps={steps} activeStep={activeStep} />
			<Box sx={{ width: "100%", margin: "0 auto" }}>
				{activeStep === 0 && (
					<Box
						width="100%"
						maxWidth="440px"
						gap="40px"
						display="flex"
						flexDirection="column"
						margin="0 auto"
					>
						<Box sx={{ display: "flex", flexDirection: "column", gap: "8px" }}>
							<Typography variant="heading-large" color="base.03" sx={{ textAlign: "center" }}>
								Verify your account
							</Typography>
							<Typography variant="body-medium" color="base.03" sx={{ textAlign: "center" }}>
								Please enter the verification code we’ve sent to to {user?.email}
							</Typography>
						</Box>
						<VerificationFlowEmail
							onSuccess={handleNext}
							resendSlot={emailResendSlot}
							onSendCode={() => startTimer(setEmailTimer)}
						/>
					</Box>
				)}
				{activeStep === 1 && (
					<Box
						width="100%"
						maxWidth="440px"
						gap="40px"
						display="flex"
						flexDirection="column"
						margin="0 auto"
					>
						<Box sx={{ display: "flex", flexDirection: "column", gap: "8px" }}>
							<Typography variant="heading-large" color="base.03" sx={{ textAlign: "center" }}>
								Verify your account
							</Typography>
							<Typography variant="body-medium" color="base.03" sx={{ textAlign: "center" }}>
								For better security we require a valid phone number.
							</Typography>
						</Box>
						<VerificationFlowPhone onSubmit={handlePhoneSubmit} />
					</Box>
				)}
				{activeStep === 2 && (
					<Box
						width="100%"
						maxWidth="440px"
						gap="40px"
						display="flex"
						flexDirection="column"
						margin="0 auto"
					>
						<Box sx={{ display: "flex", flexDirection: "column", gap: "8px" }}>
							<Typography variant="heading-large" color="base.03" sx={{ textAlign: "center" }}>
								Verify your account
							</Typography>
							<Typography variant="body-medium" color="base.03" sx={{ textAlign: "center" }}>
								{isComplete
									? "Your account has been successfully verified. Redirecting..."
									: "Please enter the verification code we’ve sent to to your phone"}
							</Typography>
						</Box>
						<VerificationFlowPhoneCode
							onSubmit={handlePhoneCodeSubmit}
							phoneNumber={phoneNumber}
							resendSlot={phoneResendSlot}
						/>
					</Box>
				)}
			</Box>
		</Box>
	);
}
