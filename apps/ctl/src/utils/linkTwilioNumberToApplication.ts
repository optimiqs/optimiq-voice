import phone from "phone";
import { Twilio } from "twilio";
import * as OptimiqVoice from "@optimiq-voice/sdk";
import { Transport } from "@optimiq-voice/types";
import {
	assignTwilioNumberToTrunk,
	createTwilioTrunk,
	getOptimiqVoiceNumberByTelUrl,
	getOptimiqVoiceTrunkByInboundUri,
	getTwilioNumber,
	getTwilioTrunk,
	LinkTwilioNumberToApplicationParams,
} from ".";
import { TWILIO_PSTN_URI_BASE } from "../constants";

async function linkTwilioNumberToApplication(
	twilioClient: Twilio,
	optimiqVoiceClient: OptimiqVoice.Client,
	params: LinkTwilioNumberToApplicationParams,
): Promise<void> {
	const { applicationRef, accessKeyId, aclEntries, originationUriBase, phoneNumber, friendlyName } =
		params;

	const resourceRef = accessKeyId.toLowerCase();

	const twilioNumber = await getTwilioNumber(twilioClient, phoneNumber);

	let twilioTrunk = await getTwilioTrunk(twilioClient, `${resourceRef}.${TWILIO_PSTN_URI_BASE}`);

	const optimiqVoiceTrunk = await getOptimiqVoiceTrunkByInboundUri(
		optimiqVoiceClient,
		`${resourceRef}.${originationUriBase}`,
	);

	const optimiqVoiceNumber = await getOptimiqVoiceNumberByTelUrl(
		optimiqVoiceClient,
		`tel:${phoneNumber}`,
	);

	if (!twilioNumber) {
		throw Error(`The number ${phoneNumber} was not found in your account.`);
	}

	if (!twilioTrunk) {
		await createTwilioTrunk(twilioClient, {
			resourceRef,
			aclEntries,
			originationUriBase,
		});

		twilioTrunk = await getTwilioTrunk(twilioClient, `${resourceRef}.${TWILIO_PSTN_URI_BASE}`);
	}

	await assignTwilioNumberToTrunk(twilioClient, phoneNumber, twilioTrunk.sid);

	let trunkRef = optimiqVoiceTrunk?.ref;

	if (!optimiqVoiceTrunk) {
		const trunks = new OptimiqVoice.Trunks(optimiqVoiceClient);
		const response = await trunks.createTrunk({
			name: "Twilio Trunk",
			inboundUri: `${resourceRef}.${originationUriBase}`,
			sendRegister: true,
			uris: [
				{
					host: `${resourceRef}.${TWILIO_PSTN_URI_BASE}`,
					port: 5060,
					// TODO: This should be a parameter (e.g., a flag)
					transport: "UDP" as Transport,
					enabled: true,
					weight: 10,
					priority: 10,
				},
			],
		});

		trunkRef = response.ref;
	}

	if (optimiqVoiceNumber) {
		const numbers = new OptimiqVoice.Numbers(optimiqVoiceClient);
		await numbers.deleteNumber(optimiqVoiceNumber.ref);
	}

	const numbers = new OptimiqVoice.Numbers(optimiqVoiceClient);
	const phoneInfo = phone(phoneNumber);

	await numbers.createNumber({
		name: friendlyName ?? phoneNumber,
		telUrl: `tel:${phoneNumber}`,
		appRef: applicationRef,
		trunkRef,
		city: "unknown",
		country: phoneInfo.countryIso3,
		countryIsoCode: phoneInfo.countryIso2,
	});
}

export { linkTwilioNumberToApplication };
