export function lastUuidSegment(str: string): string {
	return str ? str.split("-").pop() || str : "";
}
