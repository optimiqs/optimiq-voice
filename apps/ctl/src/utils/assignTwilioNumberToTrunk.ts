import { Twilio } from "twilio";

async function assignTwilioNumberToTrunk(
	client: Twilio,
	phoneNumber: string,
	trunkSid: string,
): Promise<void> {
	try {
		const numbers = await client.incomingPhoneNumbers.list({
			phoneNumber,
			limit: 1,
		});

		if (numbers.length === 0) {
			throw new Error(`Phone number ${phoneNumber} not found in your Twilio account.`);
		}

		const numberSid = numbers[0].sid;

		// Step 2: Update the Voice URL of the number to point to the trunk's domain URI
		await client.incomingPhoneNumbers(numberSid).update({
			trunkSid,
		});
	} catch (error: unknown) {
		throw new Error(`Failed to assign phone number to trunk: ${(error as Error).message}`);
	}
}

export { assignTwilioNumberToTrunk };
