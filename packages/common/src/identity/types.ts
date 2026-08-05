import { Role } from "@optimiq-voice/types";

enum TokenUseEnum {
	ID = "id",
	ACCESS = "access",
	REFRESH = "refresh",
}

enum JsonWebErrorEnum {
	JsonWebTokenError = "JsonWebTokenError",
	TokenExpiredError = "TokenExpiredError",
}

type RoleType = {
	name: string;
	description: string;
	access: string[];
};

type Access = {
	accessKeyId: string;
	role: Role;
};

type BaseToken = {
	iss: string;
	sub: string;
	aud: string;
	exp: number;
	iat: number;
	tokenUse: TokenUseEnum;
	accessKeyId: string;
};

type IdToken = BaseToken & {
	emailVerified: boolean;
	phoneNumberVerified: boolean;
	phoneNumber: string;
	email: string;
	tokenUse: TokenUseEnum.ID;
};

type AccessToken = BaseToken & {
	access: Access[];
	tokenUse: TokenUseEnum.ACCESS;
};

type RefreshToken = BaseToken & {
	tokenUse: TokenUseEnum.REFRESH;
};

type DecodedToken<T extends TokenUseEnum> = T extends TokenUseEnum.ID
	? IdToken
	: T extends TokenUseEnum.ACCESS
		? AccessToken
		: T extends TokenUseEnum.REFRESH
			? TokenUseEnum
			: never;

export {
	Access,
	AccessToken,
	DecodedToken,
	IdToken,
	RefreshToken,
	RoleType,
	TokenUseEnum,
	JsonWebErrorEnum,
};
