import { ContactType } from "@optimiq-voice/types";
import { VERIFICATION_CODE_EXPIRATION } from "../constants";
import { Database } from "../db";

function createIsValidVerificationCode(db: Database) {
	return async (params: { type: ContactType; value: string; code: string }) => {
		const { type, value, code } = params;

		// Delete old verification codes
		await db.verificationCode.deleteMany({
			where: {
				expiresAt: {
					lt: new Date(Date.now() - VERIFICATION_CODE_EXPIRATION),
				},
			},
		});

		const result = await db.verificationCode.findFirst({
			where: {
				type,
				value,
				code,
			},
		});

		return !!result;
	};
}

export { createIsValidVerificationCode };
