import { VoiceLanguage } from "@optimiq-voice/common";

type SpeechResult = {
	speech: string;
	isFinal: boolean;
	responseTime: number;
};

type StreamSpeech = {
	on(events: string, callback: (result: SpeechResult) => void): void;
	// close: () => void;
};

type SttConfig = {
	config: {
		languageCode: VoiceLanguage;
	};
};

type GoogleSttConfig = {
	config: {
		languageCode: VoiceLanguage;
	};
	credentials: {
		client_email: string;
		private_key: string;
	};
};

enum DeepgramModel {
	NOVA_3 = "nova-3",
	NOVA_2 = "nova-2",
	NOVA_2_PHONECALL = "nova-2-phonecall",
	NOVA_2_CONVERSATIONALAI = "nova-2-conversationalai",
}

type DeepgramSttConfig = {
	config: {
		languageCode: VoiceLanguage;
		model: DeepgramModel;
		smartFormat: boolean;
		noDelay: boolean;
		interimResults?: boolean;
		utteranceEndMs?: number;
	};
	credentials: {
		apiKey: string;
	};
};

export { DeepgramModel, DeepgramSttConfig, GoogleSttConfig, SpeechResult, StreamSpeech, SttConfig };
