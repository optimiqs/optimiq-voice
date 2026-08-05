import { assign, setup } from "xstate";
import { getLogger } from "@optimiq-voice/logger";
import { ConversationSettings } from "../assistants";
import { LanguageModel } from "../models";
import { Voice } from "../voice";
import * as actions from "./actions";
import * as actors from "./actors";
import delays from "./delays";
import * as guards from "./guards";
import { AutopilotContext, AutopilotEvents } from "./types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

const machineSetup = setup({
  types: {
    context: {} as AutopilotContext,
    input: {} as {
      conversationSettings: ConversationSettings;
      languageModel: LanguageModel;
      voice: Voice;
    },
    events: {} as AutopilotEvents
  },
  actions: {
    ...actions,
    // FIX: Move all this to the actions folder
    appendSpeech: assign(({ context, event }) => {
      const speech = (event as unknown as { speech: string }).speech;

      logger.verbose("called the appendSpeech action", { speech });

      if (!speech) {
        return context;
      }

      context.speechBuffer = (
        (context.speechBuffer ?? "") +
        " " +
        speech
      ).trimStart();

      logger.verbose("appended speech to the buffer", {
        speechBuffer: context.speechBuffer
      });

      return context;
    }),
    cleanSpeech: assign({ speechBuffer: "" }),
    increaseIdleTimeoutCount: assign(({ context }) => {
      logger.verbose("called the increaseIdleTimeoutCount action", {
        idleTimeoutCount: context.idleTimeoutCount + 1
      });
      context.idleTimeoutCount++;
      return context;
    }),
    resetIdleTimeoutCount: assign(({ context }) => {
      logger.verbose("called the resetIdleTimeoutCount action", {
        idleTimeoutCount: 0
      });
      context.idleTimeoutCount = 0;
      return context;
    }),
    resetState: assign(({ context }) => {
      logger.verbose("called the resetState action");
      return {
        ...context,
        speechBuffer: "",
        idleTimeoutCount: 0
      };
    })
  },
  guards,
  delays,
  actors
});

export { machineSetup };
