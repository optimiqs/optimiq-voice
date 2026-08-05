import { Database } from "../db";

function createGetUserByAccessKeyId(db: Database) {
	return function getUserByAccessKeyId(accessKeyId: string) {
		return db.user.findFirst({
			where: { accessKeyId },
		});
	};
}

export { createGetUserByAccessKeyId };
