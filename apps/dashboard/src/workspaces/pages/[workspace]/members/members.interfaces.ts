import type { Role, WorkspaceMemberStatus } from "@optimiq-voice/types";

export interface WorkspaceMemberDTO {
	ref: string;
	userRef: string;
	name: string;
	email: string;
	role: Role;
	status: WorkspaceMemberStatus;
	createdAt: Date;
	updatedAt: Date;
}
