/**
 * gRPC methods reachable without an access token. This is the single source of
 * truth for Identity's public methods, shared by the standalone Identity service
 * and the api monolith (which appends its own non-identity entries).
 */
const identityAllowList = [
  "/grpc.health.v1.Health/Check",
  "/optimiq_voice.identity.v1beta2.Identity/CreateUser",
  "/optimiq_voice.identity.v1beta2.Identity/CreateUserWithOauth2Code",
  "/optimiq_voice.identity.v1beta2.Identity/CreateWorkspace",
  "/optimiq_voice.identity.v1beta2.Identity/ExchangeApiKey",
  "/optimiq_voice.identity.v1beta2.Identity/ExchangeCredentials",
  "/optimiq_voice.identity.v1beta2.Identity/ExchangeOauth2Code",
  "/optimiq_voice.identity.v1beta2.Identity/ExchangeRefreshToken",
  "/optimiq_voice.identity.v1beta2.Identity/SendVerificationCode",
  "/optimiq_voice.identity.v1beta2.Identity/VerifyCode",
  "/optimiq_voice.identity.v1beta2.Identity/GetPublicKey",
  "/optimiq_voice.identity.v1beta2.Identity/SendResetPasswordCode",
  "/optimiq_voice.identity.v1beta2.Identity/ResetPassword"
];

export { identityAllowList };
