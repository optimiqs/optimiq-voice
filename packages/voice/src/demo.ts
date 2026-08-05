import { getLogger } from "@optimiq-voice/logger";
import VoiceServer, { GatherSource, VoiceRequest, VoiceResponse } from ".";

const logger = getLogger({ service: "voice", filePath: __filename });

const authUrl = process.env.AUTH_URL ?? "";
// Token verification is skipped for local development only, and only when no AUTH_URL is set.
const skipTokenVerification = process.env.NODE_ENV === "development" && authUrl.length === 0;

new VoiceServer({ authUrl, skipTokenVerification }).listen(
	async (req: VoiceRequest, res: VoiceResponse) => {
		logger.verbose("voice request", { ...req });

		await res.answer();

		await res.say("Hi there! What's your name?");

		const { speech: name } = await res.gather({
			source: GatherSource.SPEECH,
		});

		await res.say("Nice to meet you " + name + "!");

		await res.say("Please enter your 4 digit pin.");

		const { digits } = await res.gather({
			maxDigits: 4,
			finishOnKey: "#",
		});

		await res.say("Your pin is " + digits);

		await res.hangup();
	},
);
