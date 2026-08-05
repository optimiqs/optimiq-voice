import { z } from "zod";

/**
 * 12 characters is the floor NIST SP 800-63B recommends once composition rules are dropped, and
 * dropping them is the point: a long passphrase beats a short one with a symbol bolted on.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

export const signUpSchema = z
	.strictObject({
		name: z.string().trim().min(1, "Enter your name"),
		email: z.email("Enter a valid email address"),
		password: z
			.string()
			.min(MINIMUM_PASSWORD_LENGTH, `Use at least ${MINIMUM_PASSWORD_LENGTH} characters`),
		confirmPassword: z.string().min(1, "Confirm your password"),
	})
	.refine((values) => values.password === values.confirmPassword, {
		message: "Passwords do not match",
		path: ["confirmPassword"],
	});

export type SignUpValues = z.input<typeof signUpSchema>;

export const defaultSignUpValues: SignUpValues = {
	name: "",
	email: "",
	password: "",
	confirmPassword: "",
};

export const SIGN_UP_FIELD_ORDER = ["name", "email", "password", "confirmPassword"] as const;

export type SignUpField = (typeof SIGN_UP_FIELD_ORDER)[number];
