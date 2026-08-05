export interface Session {
	refreshToken: string;
	accessToken: string;
	idToken: string;
}

export interface CookieSession {
	refreshToken: string;
}

export interface SessionRequest {
	session: CookieSession | null;
	isAuthenticated: boolean;
}

export interface RequiredSessionRequest {
	session: CookieSession;
	isAuthenticated: boolean;
}

export interface SessionFlashData {
	error: string;
}
