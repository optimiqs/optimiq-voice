import { EmailParams, SmsParams } from "@optimiq-voice/common";

enum ContactType {
	EMAIL = "EMAIL",
	PHONE = "PHONE",
}

type SendVerificationCodeRequest = {
	contactType: ContactType;
	value: string;
};

type VerifyCodeRequest = {
	username: string;
	contactType: ContactType;
	value: string;
	verificationCode: string;
};

type VerificationParams = {
	templateDir?: string;
	recipient: string;
	verificationCode: string;
};

type SendEmailVerificationCode = (
	sendEmail: (params: EmailParams) => Promise<void>,
	request: VerificationParams,
) => Promise<void>;

type SendPhoneVerificationCode = (
	sendSms: (params: SmsParams) => Promise<void>,
	request: VerificationParams,
) => Promise<void>;

export {
	ContactType,
	SendEmailVerificationCode,
	SendPhoneVerificationCode,
	SendVerificationCodeRequest,
	VerificationParams,
	VerifyCodeRequest,
};
