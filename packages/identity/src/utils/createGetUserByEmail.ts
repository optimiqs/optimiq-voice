import { Database } from "../db";

function createGetUserByEmail(db: Database) {
  return async function getUserByEmail(email: string) {
    if (!email) {
      return null;
    }

    return await db.user.findFirst({
      where: {
        email
      }
    });
  };
}

export { createGetUserByEmail };
