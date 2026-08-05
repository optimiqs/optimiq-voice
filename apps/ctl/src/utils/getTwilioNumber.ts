import { Twilio } from "twilio";
import { IncomingPhoneNumberInstance } from "twilio/lib/rest/api/v2010/account/incomingPhoneNumber";

async function getTwilioNumber(
  client: Twilio,
  phoneNumber: string
): Promise<IncomingPhoneNumberInstance> {
  try {
    const numbers = await client.incomingPhoneNumbers.list();
    return numbers.filter((number) => number.phoneNumber === phoneNumber)[0];
  } catch (error: unknown) {
    throw new Error(
      `Error checking ownership of phone number: ${(error as Error).message}`
    );
  }
}

export { getTwilioNumber };
