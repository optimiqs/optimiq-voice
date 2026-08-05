import { LanguageModel } from "../models";
import { Voice } from "../voice";

type AutopilotContext = {
	mediaSessionRef: string;
	languageModel: LanguageModel;
	voice: Voice;
	firstMessage?: string;
	goodbyeMessage: string;
	transferMessage?: string;
	transferPhoneNumber?: string;
	transferTimeout?: number;
	systemErrorMessage: string;
	idleMessage: string;
	idleTimeout: number;
	idleTimeoutCount: number;
	maxIdleTimeoutCount: number;
	maxSpeechWaitTimeout: number;
	speechBuffer: string;
	speechResponseTime: number;
	knowledgeBaseSourceUrl?: string;
	initialDtmf?: string;
	previousState: string | null;
	hasLateSpeech: boolean;
	isFirstTurn: boolean;
	allowUserBargeIn: boolean;
};

type AutopilotEvents =
	| { type: "SPEECH_START" }
	| { type: "SPEECH_END" }
	| { type: "SPEECH_RESULT"; speech: string; responseTime: number };

export { AutopilotContext, AutopilotEvents };
