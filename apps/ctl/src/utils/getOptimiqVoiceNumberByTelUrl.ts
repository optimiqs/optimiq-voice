import * as OptimiqVoice from "@optimiq-voice/sdk";
import { INumber } from "@optimiq-voice/types";

async function getOptimiqVoiceNumberByTelUrl(
	client: OptimiqVoice.Client,
	telUrl: string,
): Promise<INumber> {
	try {
		const numbers = new OptimiqVoice.Numbers(client);
		const numbersList = await numbers.listNumbers({ pageSize: 1000 });
		return numbersList.items.filter((number) => number.telUrl === telUrl)[0];
	} catch (error: unknown) {
		throw new Error(`Error checking Optimiq Voice Number existence: ${(error as Error).message}`);
	}
}

export { getOptimiqVoiceNumberByTelUrl };
