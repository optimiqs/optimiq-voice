import { Database } from "../db";

function createGetUserByWorkspaceAccessKeyId(db: Database) {
  return async (accessKeyId: string) => {
    const workspace = await db.workspace.findFirst({
      where: { accessKeyId }
    });

    if (!workspace) return null;

    return db.user.findFirst({
      where: { ref: workspace.ownerRef }
    });
  };
}

export { createGetUserByWorkspaceAccessKeyId };
