import { createSendEmail as createSendEmailOriginal } from "@optimiq-voice/common";
import { IdentityConfig } from "../exchanges/types";

function createSendEmail(identityConfig: IdentityConfig) {
  const { smtpConfig } = identityConfig;
  const { host, port, secure, sender, auth } = smtpConfig;
  const { user, pass } = auth;

  return createSendEmailOriginal({
    sender,
    host,
    port,
    secure,
    auth: {
      user,
      pass
    }
  });
}

export { createSendEmail };
