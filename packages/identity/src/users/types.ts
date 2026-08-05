type SendResetPasswordEmailRequest = {
	recipient: string;
	templateDir?: string;
	resetPasswordUrl: string;
};

type UserUpdateInput = {
	name?: string;
	avatar?: string;
	password?: string;
	phoneNumber?: string;
	phoneNumberVerified?: boolean;
};

export { SendResetPasswordEmailRequest, UserUpdateInput };
