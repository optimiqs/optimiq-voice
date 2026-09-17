package events

import "slices"

// The presence KV value — the Go half of extensionPresenceSchema in
// packages/events/src/schemas/live-state.ts. Hand-written for the reason media_sessions.go gives.
//
// apps/engine is the only writer; apps/sipd is the only reader, on the hot path of a SUBSCRIBE and
// of every state-change NOTIFY — which is why State is a resolved top-level field.

// PresenceDeviceState is the value a busy-lamp key renders, mirroring packages/telephony's
// DEVICE_STATES in the same order.
//
// The vocabulary is closed, unlike the channel state in the `channels` bucket, because sipd maps it
// onto RFC 4235 dialog-info+xml: an unrecognised value is a NOTIFY it cannot compose, leaving a
// lamp stuck on whatever it last showed.
type PresenceDeviceState string

const (
	// PresenceDeviceStateDown is an extension with no channels. The idle lamp.
	PresenceDeviceStateDown PresenceDeviceState = "down"
	// PresenceDeviceStateRinging is alerting or dialling — inbound OR outbound.
	PresenceDeviceStateRinging PresenceDeviceState = "ringing"
	// PresenceDeviceStateActive is exactly one answered, non-held channel.
	PresenceDeviceStateActive PresenceDeviceState = "active"
	// PresenceDeviceStateActiveMulti is more than one answered, non-held channel.
	PresenceDeviceStateActiveMulti PresenceDeviceState = "active-multi"
	// PresenceDeviceStateHeld is at least one held channel and nothing answered.
	PresenceDeviceStateHeld PresenceDeviceState = "held"
	// PresenceDeviceStateUnheld is the transient resume of the single answered channel.
	PresenceDeviceStateUnheld PresenceDeviceState = "unheld"
	// PresenceDeviceStateHangup is every channel hung up and not yet reaped — the edge a phone needs
	// to clear its lamp. The publisher follows it with `down`.
	PresenceDeviceStateHangup PresenceDeviceState = "hangup"
)

// PresenceDeviceStateValues lists every member of the vocabulary, in contract order.
var PresenceDeviceStateValues = []PresenceDeviceState{
	PresenceDeviceStateDown,
	PresenceDeviceStateRinging,
	PresenceDeviceStateActive,
	PresenceDeviceStateActiveMulti,
	PresenceDeviceStateHeld,
	PresenceDeviceStateUnheld,
	PresenceDeviceStateHangup,
}

// Valid reports whether v is a member of the PresenceDeviceState vocabulary.
func (v PresenceDeviceState) Valid() bool { return slices.Contains(PresenceDeviceStateValues, v) }

func (v PresenceDeviceState) String() string { return string(v) }

// ExtensionPresence is one extension's aggregated device state, as the `presence` bucket holds it.
//
// The engine derives it from the SHARED `channels` bucket rather than any one instance's in-memory
// registry, so every replica computes the same value and last-write-wins is redundancy rather than
// conflict. Writers debounce on value, which lets a reader turn one KV update into exactly one
// NOTIFY.
//
// Absence is meaningful and differs from a `down` value: the engine deletes the key when an
// extension has no live channels, and the bucket's five-minute TTL does the same unprompted. A
// reader must clear a lamp on both.
type ExtensionPresence struct {
	OrgID string `json:"orgId"`
	// ExtensionNumber is the dialable number, e.g. "1001" — the KV key's second token. The number
	// and not the extension row id, because that is what arrives on a SUBSCRIBE.
	ExtensionNumber string              `json:"extensionNumber"`
	State           PresenceDeviceState `json:"state"`
	// ChannelCount is how many live channels the aggregation saw. 0 whenever State is `down`.
	ChannelCount int `json:"channelCount"`
	// CallStates are the per-channel packages/telephony CallState values the aggregation collapsed,
	// carried for diagnosis only — an input the writer already consumed, never something to act on.
	CallStates []string `json:"callStates,omitempty"`
	// WrittenBy is the engine instance that last wrote the entry. Not part of the answer, since every
	// instance computes the same one; it is how an operator tells which replica is still alive.
	WrittenBy string `json:"writtenBy,omitempty"`
	// UpdatedAt is epoch milliseconds, matching every other KV value on this backbone.
	UpdatedAt int64 `json:"updatedAt"`
}
