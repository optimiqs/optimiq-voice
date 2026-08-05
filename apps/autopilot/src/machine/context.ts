import { ConversationSettings } from "../assistants";
import { LanguageModel } from "../models";
import { Voice } from "../voice";

const context = ({
  input
}: {
  input: {
    voice: Voice;
    languageModel: LanguageModel;
    conversationSettings: ConversationSettings;
  };
}) => ({
  mediaSessionRef: input.voice.mediaSessionRef,
  voice: input.voice,
  languageModel: input.languageModel,
  speechBuffer: "",
  firstMessage: input.conversationSettings.firstMessage,
  goodbyeMessage: input.conversationSettings.goodbyeMessage,
  transferMessage: input.conversationSettings.transferOptions?.message,
  transferPhoneNumber: input.conversationSettings.transferOptions?.phoneNumber,
  transferTimeout: input.conversationSettings.transferOptions?.timeout,
  systemErrorMessage: input.conversationSettings.systemErrorMessage,
  idleMessage: input.conversationSettings.idleOptions.message,
  idleTimeout: input.conversationSettings.idleOptions.timeout,
  maxIdleTimeoutCount: input.conversationSettings.idleOptions.maxTimeoutCount,
  idleTimeoutCount: 0,
  maxSpeechWaitTimeout: input.conversationSettings.maxSpeechWaitTimeout,
  allowUserBargeIn: input.conversationSettings.allowUserBargeIn,
  sessionStartTime: Date.now(),
  maxSessionDuration: input.conversationSettings.maxSessionDuration,
  initialDtmf: input.conversationSettings.initialDtmf,
  previousState: null,
  hasLateSpeech: false,
  isFirstTurn: true
});

export { context };
