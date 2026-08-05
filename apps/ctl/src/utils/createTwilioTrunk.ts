import { Twilio } from "twilio";
import { TwilioTrunkParams } from ".";
import { TWILIO_PSTN_URI_BASE } from "../constants";

async function createTwilioTrunk(client: Twilio, params: TwilioTrunkParams): Promise<void> {
	const { resourceRef, originationUriBase, aclEntries } = params;

	try {
		const aclName = `ACL-${resourceRef}`;
		const trunkName = `Trunk-${resourceRef}`;
		const domainName = `${resourceRef}.${TWILIO_PSTN_URI_BASE}`;
		const originationUri = `sip:${resourceRef}.${originationUriBase}`;

		// Create ACLresource and entries
		const acl = await client.sip.ipAccessControlLists.create({
			friendlyName: aclName,
		});

		for (const ip of aclEntries) {
			await client.sip.ipAccessControlLists(acl.sid).ipAddresses.create({
				friendlyName: `${resourceRef}-entry-${ip}`,
				ipAddress: ip,
			});
		}

		// Create the trunk
		const trunk = await client.trunking.v1.trunks.create({
			friendlyName: trunkName,
			domainName: domainName,
		});

		// Add the ACL to the trunk
		await client.trunking.v1.trunks(trunk.sid).ipAccessControlLists.create({
			ipAccessControlListSid: acl.sid,
		});

		// Create origination URL
		await client.trunking.v1.trunks(trunk.sid).originationUrls.create({
			friendlyName: `Origination-${resourceRef}`,
			sipUrl: originationUri,
			priority: 10,
			weight: 10,
			enabled: true,
		});
	} catch (error: unknown) {
		throw new Error(`Failed to create resources: ${(error as Error).message}`);
	}
}

export { createTwilioTrunk };
