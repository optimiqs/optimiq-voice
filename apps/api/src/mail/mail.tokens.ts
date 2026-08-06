/**
 * Injection tokens for the mail area.
 *
 * Symbols rather than strings, per the oikos convention: a Symbol token cannot collide with
 * another module's token by accident and cannot be produced by a typo.
 */

/** The validated mail environment (`MailEnv`). */
export const MAIL_ENV = Symbol("api/mail/Env");
