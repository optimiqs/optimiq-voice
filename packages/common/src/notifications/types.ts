type EmailSenderConfig = {
  sender: string;
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
};

type EmailParams = {
  to: string;
  subject: string;
  html: string;
};

type SmsSenderConfig = {
  sender: string;
};

type TwilioSmsSenderConfig = SmsSenderConfig & {
  accountSid: string;
  authToken: string;
};

type SmsParams = {
  to: string;
  body: string;
};

export {
  EmailParams,
  EmailSenderConfig,
  SmsParams,
  SmsSenderConfig,
  TwilioSmsSenderConfig
};
