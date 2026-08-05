import { Role, WorkspaceMemberStatus } from "@optimiq-voice/types";

/**
 * Human-readable labels for Role enum values.
 */
export const ROLE_LABELS: Record<Role, string> = {
  [Role.USER]: "User",
  [Role.WORKSPACE_OWNER]: "Workspace Owner",
  [Role.WORKSPACE_ADMIN]: "Workspace Admin",
  [Role.WORKSPACE_MEMBER]: "Workspace Member"
};

/**
 * Human-readable labels for WorkspaceMemberStatus enum values.
 */
export const STATUS_LABELS: Record<WorkspaceMemberStatus, string> = {
  [WorkspaceMemberStatus.PENDING]: "Pending",
  [WorkspaceMemberStatus.ACTIVE]: "Active"
};
