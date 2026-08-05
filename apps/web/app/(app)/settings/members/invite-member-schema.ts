import { z } from "zod";
import { SYSTEM_ROLE_IDS } from "~/lib/permissions";

/**
 * All five role templates are offered, not better-auth's three built-ins.
 *
 * `packages/auth/src/access-control.ts` registers `owner` / `admin` / `manager` / `agent` / `user`
 * with the organization plugin, which is what makes the last three assignable at all — without
 * that registration the invite endpoint rejects them. The list comes from the generated registry
 * so adding a template on the server adds it here.
 */
export const inviteMemberSchema = z.strictObject({
	email: z.email("Enter a valid email address"),
	role: z.enum(SYSTEM_ROLE_IDS),
});

export type InviteMemberValues = z.input<typeof inviteMemberSchema>;

export const defaultInviteMemberValues: InviteMemberValues = { email: "", role: "user" };

export const INVITE_MEMBER_FIELD_ORDER = ["email", "role"] as const;

export type InviteMemberField = (typeof INVITE_MEMBER_FIELD_ORDER)[number];
