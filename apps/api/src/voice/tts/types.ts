type SynthOptions = {
	voice: string;
};

type DeepgramTtsConfig = {
	[key: string]: Record<string, string>;
	credentials: {
		apiKey: string;
	};
};

type ElevenLabsTtsConfig = {
	[key: string]: Record<string, string>;
	credentials: {
		apiKey: string;
	};
};

type GoogleTtsConfig = {
	[key: string]: Record<string, string>;
	credentials: {
		client_email: string;
		private_key: string;
	};
};

type AzureTTSConfig = {
	[key: string]: Record<string, string>;
	credentials: {
		subscriptionKey: string;
		serviceRegion: string;
	};
};

export {
	type SynthOptions,
	type AzureTTSConfig,
	type DeepgramTtsConfig,
	type ElevenLabsTtsConfig,
	type GoogleTtsConfig,
};
