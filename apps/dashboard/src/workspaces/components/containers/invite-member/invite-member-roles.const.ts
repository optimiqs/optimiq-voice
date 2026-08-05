import { Role } from "@optimiq-voice/types";
import { ROLE_LABELS } from "~/workspaces/pages/[workspace]/members/members.constants";

export const ROLE_OPTIONS = [
	{
		label: ROLE_LABELS[Role.WORKSPACE_ADMIN],
		value: Role.WORKSPACE_ADMIN,
	},
	{
		label: ROLE_LABELS[Role.WORKSPACE_MEMBER],
		value: Role.WORKSPACE_MEMBER,
	},
];
