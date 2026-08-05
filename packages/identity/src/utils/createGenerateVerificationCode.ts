import { ContactType } from "@optimiq-voice/types";
import { VERIFICATION_CODE_EXPIRATION } from "../constants";
import { Database } from "../db";

function createGenerateVerificationCode(db: Database) {
	return async (params: { type: ContactType; value: string }) => {
		const { type, value } = params;
		const code = Math.floor(100000 + Math.random() * 900000).toString();

		await db.verificationCode.create({
			data: {
				type,
				value,
				code,
				expiresAt: new Date(Date.now() + VERIFICATION_CODE_EXPIRATION),
			},
		});

		return code;
	};
}

export { createGenerateVerificationCode };
