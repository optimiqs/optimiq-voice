enum AriEvent {
	STASIS_START = "StasisStart",
	STASIS_END = "StasisEnd",
	CHANNEL_USER_EVENT = "ChannelUserevent",
	CHANNEL_DTMF_RECEIVED = "ChannelDtmfReceived",
	PLAYBACK_FINISHED = "PlaybackFinished",
	RECORDING_FINISHED = "RecordingFinished",
	RECORDING_FAILED = "RecordingFailed",
	WEB_SOCKET_RECONNECTING = "WebSocketReconnecting",
	WEB_SOCKET_MAX_RETRIES = "WebSocketMaxRetries",
	CHANNEL_LEFT_BRIDGE = "ChannelLeftBridge",
	DIAL = "Dial",
}

enum ChannelVar {
	CALL_DIRECTION = "CALL_DIRECTION",
	INGRESS_NUMBER = "INGRESS_NUMBER",
	APP_REF = "APP_REF",
	APP_ENDPOINT = "APP_ENDPOINT",
	METADATA = "METADATA",
	FROM_EXTERNAL_MEDIA = "FROM_EXTERNAL_MEDIA",
	CALL_REF = "CALL_REF",
}

export { AriEvent, ChannelVar };
