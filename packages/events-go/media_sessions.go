package events

// The media-sessions KV value — the Go half of
// packages/events/src/schemas/live-state.ts's mediaSessionDirectoryEntrySchema.
//
// Hand-written rather than generated, like registration.go, because the codegen registry covers
// EVENTS and RPC payloads: a KV value has no subject and no envelope, so there is nothing for the
// emitter to hang it off. The parity golden still pins the bucket definition and the key builder,
// which are the two things a disagreement would actually break.
//
// apps/mediad is the only writer. apps/engine reads it to attribute a refusal ("that session is on
// another instance") and, later, a drain will read it to enumerate what has to move.

// MediaSessionDirectoryEntry says which mediad instance owns one RTP session.
//
// Every field except the optional ones is written on every allocate. There is deliberately no
// expiry or heartbeat: nothing races for a media session, so this is a statement of fact written
// after the fact rather than a claim taken before one. See MediaSessionsKV.
type MediaSessionDirectoryEntry struct {
	SessionID string `json:"sessionId"`
	// InstanceID is the mediad process that owns it. THE field this bucket exists for.
	InstanceID string `json:"instanceId"`
	OrgID      string `json:"orgId"`
	CallID     string `json:"callId"`
	LegID      string `json:"legId,omitempty"`
	// Address and RTPPort are what went into the SDP answer's c=/m= lines — the PUBLIC address,
	// never the bind one.
	Address  string `json:"address"`
	RTPPort  int    `json:"rtpPort"`
	RTCPPort int    `json:"rtcpPort"`
	// Codec is the payload type the answer settled on ("PCMU"/"PCMA"), so a reader can tell what
	// the session is carrying without asking the instance.
	Codec string `json:"codec,omitempty"`
	// BridgeID is the relay this session is part of, when bridged. Present here as well as in
	// mediad's memory because it is what makes a bridge visible to anything that is not the owning
	// instance.
	BridgeID string `json:"bridgeId,omitempty"`
	// AllocatedAt is epoch milliseconds, matching every other KV value on this backbone.
	AllocatedAt int64 `json:"allocatedAt"`
}
