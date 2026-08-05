/**
 * Log redaction for a telephony platform.
 *
 * Everything that reaches a log line here is assumed to be attacker-visible eventually. Two
 * layers run together: a key-name pattern that blanks whole fields, and value scrubbers that
 * catch secrets embedded inside otherwise-innocent strings (SIP headers, ARI payloads,
 * stack traces, provider error bodies).
 *
 * Phone numbers are PII on this platform, so E.164 values are scrubbed the same way emails
 * and bearer tokens are.
 */

/** Field names whose value is never safe to emit, regardless of shape. */
const SENSITIVE_LOG_PATTERN =
	/(authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|credential|api[-_]?key|apikey|session|private[-_]?key|signature|email|phone|caller[-_]?id|callerid|from[-_]?number|to[-_]?number|\bdid\b|did[-_]?number|msisdn|sip[-_]?password|ari[-_]?secret|first[-_]?name|last[-_]?name|full[-_]?name|address|dtmf|digits)/i;

const REDACTED_LOG_VALUE = "[REDACTED]";

/** Cyclic-safe recursion ceiling. Anything deeper is almost certainly a dumped object graph. */
export const MAX_REDACTION_DEPTH = 6;

const EMAIL_PATTERN = /[\w!#$%&'*+/=?`{|}~^.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const E164_PHONE_PATTERN = /\+[1-9]\d{6,14}\b/g;
const HEX_TOKEN_PATTERN = /\b[A-Fa-f0-9]{64,}\b/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._-]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
/** Credential tokens carried in query strings, which the opaque-token patterns cannot match. */
const QUERY_TOKEN_PATTERN = /([?&](?:token|access_token|auth_token|api_key)=)[^&\s"']+/gi;
/** SIP/ARI digest credentials embedded in a header or URI userinfo. */
const SIP_URI_CREDENTIAL_PATTERN = /(sips?:\/\/[^:@\s]+):[^@\s]+@/gi;
const BASIC_AUTH_URL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:@/\s]+):[^@/\s]+@/gi;
/**
 * `key: value` / `key=value` secrets in free-form text. `&` terminates the value so a query
 * string with several parameters is not swallowed whole by the first match.
 */
const SENSITIVE_ASSIGNMENT_PATTERN =
	/((?:"|')?(?:authorization|cookie|token|secret|password|api[-_]?key|session|set-cookie)(?:"|')?\s*[:=]\s*(?:"|')?)[^"',}\s&]+/gi;

function stringifyUnknownScalar(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "boolean"
	) {
		return String(value);
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof URL || value instanceof URLSearchParams) {
		return value.toString();
	}
	if (value instanceof Error) {
		return value.message;
	}
	if (value instanceof Uint8Array) {
		return new TextDecoder().decode(value);
	}
	if (Array.isArray(value)) {
		return value
			.map((entry) => stringifyUnknownScalar(entry))
			.filter(Boolean)
			.join(",");
	}
	if (typeof value === "object" && "url" in value && typeof value.url === "string") {
		return value.url;
	}
	if (typeof value === "object") {
		return "[object Object]";
	}
	return "";
}

/** Scrubs secrets and PII out of a free-form string without discarding the surrounding text. */
export const scrubSensitiveString = (input: unknown): string => {
	if (input === null || input === undefined) {
		return "";
	}
	const value = typeof input === "string" ? input : stringifyUnknownScalar(input);
	if (!value) {
		return value;
	}
	return (
		value
			.replace(JWT_PATTERN, "[REDACTED-JWT]")
			.replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
			.replace(QUERY_TOKEN_PATTERN, "$1[REDACTED]")
			.replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1[REDACTED]")
			// `<REDACTED>` (not `[REDACTED]`) so the email scrubber below cannot mistake the
			// replacement for a mailbox local part and swallow the surrounding host.
			.replace(SIP_URI_CREDENTIAL_PATTERN, "$1:<REDACTED>@")
			.replace(BASIC_AUTH_URL_PATTERN, "$1:<REDACTED>@")
			.replace(EMAIL_PATTERN, "[REDACTED-EMAIL]")
			.replace(E164_PHONE_PATTERN, "[REDACTED-PHONE]")
			.replace(HEX_TOKEN_PATTERN, "[REDACTED-HEX]")
	);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
};

export interface RedactedError {
	name: string;
	message: string;
	stack?: string;
}

export const redactErrorValue = (error: Error): RedactedError => ({
	name: scrubSensitiveString(error.name),
	message: scrubSensitiveString(error.message),
	stack: error.stack ? scrubSensitiveString(error.stack) : undefined,
});

export const redactLogValue = (
	value: unknown,
	depth = 0,
	seen = new WeakSet<object>(),
): unknown => {
	if (value === null || typeof value !== "object") {
		return typeof value === "string" ? scrubSensitiveString(value) : value;
	}

	if (value instanceof Date) {
		return value;
	}

	if (value instanceof Error) {
		return redactErrorValue(value);
	}

	if (seen.has(value)) {
		return "[Circular]";
	}

	if (depth >= MAX_REDACTION_DEPTH) {
		return "[Truncated]";
	}

	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((entry) => redactLogValue(entry, depth + 1, seen));
		}

		if (!isPlainObject(value)) {
			return scrubSensitiveString(stringifyUnknownScalar(value));
		}

		const redacted: Record<string, unknown> = {};
		for (const [key, nestedValue] of Object.entries(value)) {
			redacted[key] = SENSITIVE_LOG_PATTERN.test(key)
				? REDACTED_LOG_VALUE
				: redactLogValue(nestedValue, depth + 1, seen);
		}
		return redacted;
	} finally {
		seen.delete(value);
	}
};

export const isSensitiveLogKey = (key: string): boolean => SENSITIVE_LOG_PATTERN.test(key);
