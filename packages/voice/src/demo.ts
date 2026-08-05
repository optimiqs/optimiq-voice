import { getLogger } from "@optimiq-voice/logger";
import VoiceServer, { GatherSource, VoiceRequest, VoiceResponse } from ".";

const logger = getLogger({ service: "voice", filePath: __filename });

const skipIdentity = process.env.NODE_ENV === "development";

// Only skip identity for local development
new VoiceServer({ skipIdentity }).listen(
  async (req: VoiceRequest, res: VoiceResponse) => {
    logger.verbose("voice request", { ...req });

    await res.answer();

    await res.say("Hi there! What's your name?");

    const { speech: name } = await res.gather({
      source: GatherSource.SPEECH
    });

    await res.say("Nice to meet you " + name + "!");

    await res.say("Please enter your 4 digit pin.");

    const { digits } = await res.gather({
      maxDigits: 4,
      finishOnKey: "#"
    });

    await res.say("Your pin is " + digits);

    await res.hangup();
  }
);
