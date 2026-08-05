import * as OptimiqVoice from "@optimiq-voice/sdk";
import { Trunk } from "@optimiq-voice/types";

async function getOptimiqVoiceTrunkByInboundUri(
  client: OptimiqVoice.Client,
  inboundUri: string
): Promise<Trunk> {
  try {
    const trunks = new OptimiqVoice.Trunks(client);
    const trunksList = await trunks.listTrunks({ pageSize: 1000 });
    return trunksList.items.filter(
      (trunk) => trunk.inboundUri === inboundUri
    )[0];
  } catch (error: unknown) {
    throw new Error(
      `Error checking SIP trunk existence: ${(error as Error).message}`
    );
  }
}

export { getOptimiqVoiceTrunkByInboundUri };
