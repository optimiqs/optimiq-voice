import { Deepgram as DeepgramStt } from "../../voice/stt/Deepgram";
import { Google as GoogleStt } from "../../voice/stt/Google";
import { Azure as AzureTts } from "../../voice/tts/Azure";
import { Deepgram as DeepgramTts } from "../../voice/tts/Deepgram";
import { ElevenLabs as ElevenLabsTts } from "../../voice/tts/ElevenLabs";
import { Google as GoogleTts } from "../../voice/tts/Google";

const speechValidators = {
	ttsConfigValidators: {
		"tts.google": GoogleTts.getConfigValidationSchema,
		"tts.azure": AzureTts.getConfigValidationSchema,
		"tts.deepgram": DeepgramTts.getConfigValidationSchema,
		"tts.elevenlabs": ElevenLabsTts.getConfigValidationSchema,
	},
	ttsCredentialsValidators: {
		"tts.google": GoogleTts.getCredentialsValidationSchema,
		"tts.azure": AzureTts.getCredentialsValidationSchema,
		"tts.deepgram": DeepgramTts.getCredentialsValidationSchema,
		"tts.elevenlabs": ElevenLabsTts.getCredentialsValidationSchema,
	},
	sttConfigValidators: {
		"stt.google": GoogleStt.getConfigValidationSchema,
		"stt.deepgram": DeepgramStt.getConfigValidationSchema,
	},
	sttCredentialsValidators: {
		"stt.google": GoogleStt.getCredentialsValidationSchema,
		"stt.deepgram": DeepgramStt.getCredentialsValidationSchema,
	},
};

export { speechValidators };
