import nodemailer from "nodemailer";

/** Dev email sink: SMTP to Mailpit, a catch-all inbox with a web UI. Nothing is ever delivered to a real address. */
export function createSmtpSink(smtpUrl) {
  const transport = nodemailer.createTransport(smtpUrl, { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 });
  return {
    sendMail: (msg) => transport.sendMail(msg),
    close: () => transport.close(),
  };
}

/** SMS placeholder. Users have no phone number yet, so nothing uses it; it logs that a text WOULD be sent, never the number or text. */
export function createConsoleSmsSink(logger) {
  return { send: async ({ userId, template }) => logger.info({ userId, template }, "sms sent (console sink)") };
}
