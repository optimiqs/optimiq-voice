import type { Role } from "@optimiq-voice/types";

export interface ApiKey {
	ref: string;
	accessKeyId: string;
	accessKeySecret: string;
	role: Role;
	expiresAt: Date;
	createdAt: Date;
	updatedAt: Date;
}
