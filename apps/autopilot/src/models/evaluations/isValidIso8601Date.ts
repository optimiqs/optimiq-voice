export function isValidIso8601Date(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const time = Date.parse(value);
	return !Number.isNaN(time);
}
