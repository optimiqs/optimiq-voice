import { DialStatus } from "@optimiq-voice/common";

const FailedStatus = ["CHANUNAVAIL", "CONGESTION"];

function mapDialStatus(status: string): DialStatus | undefined {
	if (status === "") {
		return DialStatus.TRYING;
	}

	const normalizedStatus = status.toUpperCase();
	const dialStatusArray = Object.keys(DialStatus).map((key) => DialStatus[key]);

	if (FailedStatus.includes(normalizedStatus)) {
		return DialStatus.FAILED;
	} else if (dialStatusArray.includes(normalizedStatus)) {
		return DialStatus[normalizedStatus];
	}
	// If the status is not in the DialStatus enum, return undefined
	return undefined;
}

export { mapDialStatus };
