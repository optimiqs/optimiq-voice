import { status } from "@grpc/grpc-js";
import { GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { ContactType } from "@optimiq-voice/types";
import { Database } from "../db";
import { createIsValidVerificationCode } from "../utils/createIsValidVerificationCode";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { VerifyCodeRequest } from "./types";

function createVerifyCode(db: Database) {
	const isValidVerificationCode = createIsValidVerificationCode(db);

	const verifyCode = async (
		call: { request: VerifyCodeRequest },
		callback: (error: GrpcErrorMessage) => void,
	) => {
		const { request } = call;
		const { username, contactType, value, verificationCode } = request;
		const actualContactType = contactType ?? ContactType.EMAIL;

		const isValid = await isValidVerificationCode({
			type: actualContactType,
			value,
			code: verificationCode,
		});

		if (!isValid) {
			return callback({
				code: status.PERMISSION_DENIED,
				message: "Invalid verification code",
			});
		} else if (actualContactType === ContactType.EMAIL && isValid) {
			await db.user.update({
				where: { email: username },
				data: { emailVerified: true },
			});
		} else if (actualContactType === ContactType.PHONE && isValid) {
			await db.user.update({
				where: { email: username, phoneNumber: value },
				data: { phoneNumberVerified: true },
			});
		}

		callback(null);
	};

	return withErrorHandlingAndValidation(verifyCode, V.verifyCodeRequestSchema);
}

export { createVerifyCode };
