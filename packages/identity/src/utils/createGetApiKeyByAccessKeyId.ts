import { Database } from "../db";

function createGetApiKeyByAccessKeyId(db: Database) {
  return async function getApiKeyByAccessKeyId(accessKeyId: string) {
    const key = await db.apiKey.findFirst({
      where: {
        accessKeyId
      }
    });

    if (!key) {
      return null;
    }

    return key;
  };
}

export { createGetApiKeyByAccessKeyId };
