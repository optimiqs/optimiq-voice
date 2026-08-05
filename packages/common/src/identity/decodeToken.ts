import { jwtDecode } from "jwt-decode";
import { DecodedToken, TokenUseEnum } from "./types";

function decodeToken<T extends TokenUseEnum>(token: string): DecodedToken<T> {
	return jwtDecode(token);
}

export { decodeToken };
