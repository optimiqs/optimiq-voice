import { z } from "zod";
import { Validators as V } from "@optimiq-voice/common";

type IdentityConfig = {
  dbUrl: string;
  issuer: string;
  audience: string;
  privateKey: string;
  publicKey: string;
  encryptionKey: string;
  accessTokenExpiresIn: number | string;
  refreshTokenExpiresIn: number | string;
  idTokenExpiresIn: number | string;
  workspaceInviteExpiration: string;
  workspaceInviteUrl: string;
  workspaceInviteFailUrl: string;
  contactVerificationRequired: boolean;
  twoFactorAuthenticationRequired: boolean;
  smtpConfig: {
    sender: string;
    host: string;
    port: number;
    secure: boolean;
    auth: {
      user: string;
      pass: string;
    };
  };
  twilioSmsConfig?: {
    accountSid: string;
    authToken: string;
    sender: string;
  };
  githubOauth2Config?: {
    clientId: string;
    clientSecret: string;
  };
};

type ExchangeApiKeysRequest = z.infer<typeof V.exchangeApiKeysRequestSchema>;

type ExchangeOauth2CodeRequest = z.infer<typeof V.exchangeOauth2RequestSchema>;

type ExchangeCredentialsRequest = z.infer<
  typeof V.exchangeCredentialsRequestSchema
>;

type ExchangeResponse = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
};

type ExchangeRefreshTokenRequest = z.infer<
  typeof V.exchangeRefreshTokenRequestSchema
>;

export {
  ExchangeApiKeysRequest,
  ExchangeCredentialsRequest,
  ExchangeOauth2CodeRequest,
  ExchangeRefreshTokenRequest,
  ExchangeResponse,
  IdentityConfig
};
