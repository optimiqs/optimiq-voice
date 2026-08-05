import { customAlphabet } from "nanoid";

enum AccessKeyIdType {
	USER,
	WORKSPACE,
	SERVICE,
	API_KEY,
}

function generateAccessKeyId(type: AccessKeyIdType) {
	const prefix = {
		[AccessKeyIdType.USER]: "US",
		[AccessKeyIdType.WORKSPACE]: "WO",
		[AccessKeyIdType.SERVICE]: "SE",
		[AccessKeyIdType.API_KEY]: "AP",
	};

	return `${prefix[type]}${customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 32)()}`;
}

export { AccessKeyIdType, generateAccessKeyId };
