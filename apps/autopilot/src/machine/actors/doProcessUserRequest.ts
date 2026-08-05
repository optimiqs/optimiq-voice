import { fromPromise } from "xstate";
import { getLogger } from "@optimiq-voice/logger";
import { AutopilotContext } from "../types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export const doProcessUserRequest = fromPromise(
  async ({ input }: { input: { context: AutopilotContext } }) => {
    const { context } = input;
    logger.verbose("called processUserRequest actor", {
      speechBuffer: context.speechBuffer,
      hasLateSpeech: context.hasLateSpeech
    });

    // Stop any speech that might be playing
    await context.voice.stopSpeech();

    const languageModel = context.languageModel;
    const speech = context.speechBuffer.trim();
    const response = await languageModel.invoke(speech, context.hasLateSpeech);

    try {
      if (response.type === "say" && !response.content) {
        logger.warn("ignoring say response with no content");
        return;
      } else if (response.type === "hangup") {
        await context.voice.say(context.goodbyeMessage);
        await context.voice.hangup();
        return;
      } else if (response.type === "transfer") {
        logger.verbose("transferring call to a number in the PSTN", {
          phoneNumber: context.transferPhoneNumber
        });
        await context.voice.say(context.transferMessage!);
        await context.voice.stopStreams();
        await context.voice.transfer(context.transferPhoneNumber!, {
          record: true,
          timeout: context.transferTimeout / 1000
        });
        return;
      }

      await context.voice.say(response.content!);
    } catch (error) {
      logger.error("error processing user request", { error });
      await context.voice.say(context.systemErrorMessage);
    }
  }
);
