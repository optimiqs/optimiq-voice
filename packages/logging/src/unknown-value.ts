export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireUnknownRecord(value: unknown, label = "value"): Record<string, unknown> {
	if (!isUnknownRecord(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value;
}
