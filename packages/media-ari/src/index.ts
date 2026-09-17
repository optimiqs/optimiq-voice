/**
 * `@optimiq-voice/media-ari` — the Asterisk 22 ARI adapter.
 *
 * A protocol adapter and nothing else: typed REST resources, a typed event union, and a
 * reconnecting event socket. All ARI weirdness is quarantined here (plan §3.3), so that when
 * `apps/mediad` replaces Asterisk the engine's domain code does not change and this package is
 * simply deleted.
 *
 * It therefore has NO dependency on `@optimiq-voice/telephony`, `@optimiq-voice/events` or `nats`.
 */

export { computeBackoffDelayMs, DEFAULT_BACKOFF, type BackoffOptions } from "./backoff";
export { AriClient, type AriClientOptions } from "./client";
export {
	AriError,
	AriEventParseError,
	AriHttpError,
	AriResponseShapeError,
	AriSocketError,
	AriTransportError,
} from "./errors";
export {
	ARI_STREAM_STATUSES,
	AriEventStream,
	type AriEventGap,
	type AriEventStreamHandlers,
	type AriEventStreamOptions,
	type AriStreamStatus,
} from "./event-stream";
export {
	ARI_EVENT_TYPES,
	callerIdOf,
	channelOfEvent,
	isAriEventType,
	parseAriEvent,
	parseAriEventFrame,
	type AriBridgeCreatedEvent,
	type AriBridgeDestroyedEvent,
	type AriChannelCreatedEvent,
	type AriChannelDestroyedEvent,
	type AriChannelDialplanEvent,
	type AriChannelDtmfReceivedEvent,
	type AriChannelEnteredBridgeEvent,
	type AriChannelHangupRequestEvent,
	type AriChannelHoldEvent,
	type AriChannelLeftBridgeEvent,
	type AriChannelStateChangeEvent,
	type AriChannelUnholdEvent,
	type AriChannelVarsetEvent,
	type AriDialEvent,
	type AriEvent,
	type AriEventBase,
	type AriEventOf,
	type AriEventType,
	type AriPeerStatusChangeEvent,
	type AriPlaybackFinishedEvent,
	type AriPlaybackStartedEvent,
	type AriRecordingFailedEvent,
	type AriRecordingFinishedEvent,
	type AriRecordingStartedEvent,
	type AriStasisEndEvent,
	type AriStasisStartEvent,
	type AriUnknownEvent,
} from "./events";
export {
	AriHttpClient,
	type AriFetch,
	type AriHttpClientOptions,
	type AriQuery,
} from "./http-client";
export {
	ARI_CHANNEL_STATES,
	ariApplicationSchema,
	ariBridgeSchema,
	ariChannelSchema,
	ariDeviceStateSchema,
	ariEndpointSchema,
	ariLiveRecordingSchema,
	ariPeerSchema,
	ariPlaybackSchema,
	ariStoredRecordingSchema,
	ariVariableSchema,
	isAriChannelState,
	type AriApplication,
	type AriAsteriskInfo,
	type AriBridge,
	type AriCallerId,
	type AriChannel,
	type AriChannelState,
	type AriDeviceState,
	type AriDialplanCep,
	type AriEndpoint,
	type AriLiveRecording,
	type AriPeer,
	type AriPlayback,
	type AriStoredRecording,
	type AriVariable,
} from "./models";
export { AriApplications, AriAsterisk, type AriEventSource } from "./resources/applications";
export {
	ARI_BRIDGE_TYPES,
	AriBridges,
	type AriBridgeRole,
	type AriBridgeType,
	type CreateBridgeOptions,
} from "./resources/bridges";
export {
	AriChannels,
	type AriMuteDirection,
	type DtmfOptions,
	type HangupOptions,
	type OriginateOptions,
	type PlayOptions,
	type RecordOptions,
	type SnoopOptions,
} from "./resources/channels";
export { AriDeviceStates, AriEndpoints } from "./resources/endpoints";
export {
	ARI_PLAYBACK_OPERATIONS,
	AriPlaybacks,
	type AriPlaybackOperation,
} from "./resources/playbacks";
export { AriRecordings } from "./resources/recordings";
export {
	basicAuthHeader,
	buildEventsUrl,
	buildQuery,
	buildRestUrl,
	encodeSegment,
	normalizeAriBaseUrl,
	redactAriUrl,
	type AriCredentials,
	type QueryValue,
} from "./url";
