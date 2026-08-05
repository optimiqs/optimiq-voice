import { createTransport } from "nodemailer";
import { getLogger } from "@optimiq-voice/logger";
import { EmailParams, EmailSenderConfig } from "./types";

const logger = getLogger({ service: "common", filePath: __filename });

function createSendEmail(config: EmailSenderConfig) {
  const { sender, host, port, secure, auth } = config;
  const transporter = createTransport({
    host,
    port,
    secure,
    auth
  });

  return async function sendEmail(params: EmailParams): Promise<void> {
    const { to, subject, html } = params;

    const info = await transporter.sendMail({
      from: sender,
      to,
      subject,
      html
    });

    logger.verbose(`message sent: ${info.messageId}`);
  };
}

export { createSendEmail };
