package events

// The media-sessions KV value — the Go half of mediaSessionDirectoryEntrySchema in
// packages/events/src/schemas/live-state.ts. Hand-written because the codegen registry covers
// events and RPC payloads, and a KV value has no subject or envelope to hang off; the parity
// golden still pins the bucket definition and the key builder.
//
// apps/mediad is the only writer; apps/engine reads it.

// MediaSessionDirectoryEntry says which mediad instance owns one RTP session.
//
// There is deliberately no expiry or heartbeat: nothing races for a media session, so this is a
// statement of fact written after an allocate rather than a claim taken before one.
type MediaSessionDirectoryEntry struct {
	SessionID string `json:"sessionId"`
	// InstanceID is the mediad process that owns the session — the field this bucket exists for.
	InstanceID string `json:"instanceId"`
	OrgID      string `json:"orgId"`
	CallID     string `json:"callId"`
	LegID      string `json:"legId,omitempty"`
	// Address and RTPPort are what went into the SDP answer's c=/m= lines — the PUBLIC address,
	// never the bind one.
	Address  string `json:"address"`
	RTPPort  int    `json:"rtpPort"`
	RTCPPort int    `json:"rtcpPort"`
	// Codec is the payload type the answer settled on ("PCMU"/"PCMA").
	Codec string `json:"codec,omitempty"`
	// BridgeID is the relay this session is part of, when bridged. Duplicated from mediad's memory
	// so a bridge is visible to anything that is not the owning instance.
	BridgeID string `json:"bridgeId,omitempty"`
	// AllocatedAt is epoch milliseconds, matching every other KV value on this backbone.
	AllocatedAt int64 `json:"allocatedAt"`
}
