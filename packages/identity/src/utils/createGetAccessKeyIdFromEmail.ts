import { Database } from "../db";
import { createGetUserByEmail } from "./createGetUserByEmail";

function createGetAccessKeyIdFromEmail(db: Database) {
	return async function getAccessKeyIdFromEmail(email: string): Promise<string> {
		return (await createGetUserByEmail(db)(email)).accessKeyId;
	};
}

export { createGetAccessKeyIdFromEmail };
