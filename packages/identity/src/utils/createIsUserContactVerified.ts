import { Database } from "../db";

function createIsUserContactVerified(db: Database) {
  return async (accessKeyId: string) => {
    const user = await db.user.findUnique({
      where: {
        accessKeyId
      }
    });

    if (!user) {
      throw new Error("User not found");
    }

    return user.emailVerified || user.phoneNumberVerified;
  };
}

export { createIsUserContactVerified };
