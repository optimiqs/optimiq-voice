import { Twilio } from "twilio";
import { TrunkInstance } from "twilio/lib/rest/trunking/v1/trunk";

async function getTwilioTrunk(client: Twilio, terminationSipUri: string): Promise<TrunkInstance> {
	try {
		const trunks = await client.trunking.v1.trunks.list();
		return trunks.filter((trunk) => trunk.domainName === terminationSipUri)[0];
	} catch (error: unknown) {
		throw new Error(`Error checking SIP trunk existence: ${(error as Error).message}`);
	}
}

export { getTwilioTrunk };
