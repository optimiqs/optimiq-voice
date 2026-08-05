const delays = {
	IDLE_TIMEOUT: ({ context }) => context.idleTimeout,
	MAX_SPEECH_WAIT_TIMEOUT: ({ context }) => {
		// If this is the first conversational turn and there is no firstMessage,
		// use 0 timeout to avoid unnecessary delay during the intro. (Outbound calls)
		if (context.isFirstTurn && !context.firstMessage) {
			return 0;
		} else if (context.hasLateSpeech) {
			return 0;
		}
		return context.maxSpeechWaitTimeout;
	},
	MAX_SESSION_DURATION: ({ context }) => context.maxSessionDuration,
};

export { delays as default };
