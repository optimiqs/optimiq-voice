import { Role } from "@optimiq-voice/types";
import { roles } from "./roles";
import { Access, RoleType } from "./types";

// This function only checks if the role has access to the grpc method
function hasAccess(
  decodedToken: {
    access: Access[];
    accessKeyId: string;
  },
  method: string
) {
  const { access, accessKeyId } = decodedToken;
  const roleList =
    accessKeyId.startsWith("US") && // US is for user; user tokens only have USER role
    access.length === 0 // If it is a user token, and has no access, we still allow it in case it is a user method
      ? [Role.USER]
      : access.map((a: Access) => a.role);

  return roleList.some((r: string) =>
    roles.find(
      (role: RoleType) => role.name === r && role.access.includes(method)
    )
  );
}

export { hasAccess };
