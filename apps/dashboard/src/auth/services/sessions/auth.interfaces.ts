export interface IDTokenPayload {
  iss: string;
  sub: string;
  aud: string;
  tokenUse: string;
  accessKeyId: string;
  email: string;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  iat: number;
  exp: number;
}

export interface ExchangeCredentialsResponse {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}
