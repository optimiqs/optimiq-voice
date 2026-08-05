import { z } from "zod";

/**
 * The password rule here is deliberately weak: it checks that something was typed, nothing more.
 * Sign-in must never leak the account's password policy, and re-stating a minimum length on this
 * form only tells an attacker what to skip. Strength is enforced on sign-up and reset.
 */
export const signInSchema = z.strictObject({
	email: z.email("Enter a valid email address"),
	password: z.string().min(1, "Password is required"),
});

export type SignInValues = z.input<typeof signInSchema>;

export const defaultSignInValues: SignInValues = { email: "", password: "" };

/** Field names double as element ids, so this is also the focus order. */
export const SIGN_IN_FIELD_ORDER = ["email", "password"] as const;

export type SignInField = (typeof SIGN_IN_FIELD_ORDER)[number];
