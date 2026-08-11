package events

// The presence KV value — the Go half of
// packages/events/src/schemas/live-state.ts's extensionPresenceSchema.
//
// Hand-written rather than generated, like media_sessions.go and registration.go, because the
// codegen registry covers EVENTS and RPC payloads: a KV value has no subject and no envelope, so
// there is nothing for the emitter to hang it off. The parity golden still pins the bucket
// definition and the key builder, which are the two things a disagreement would actually break.
//
// apps/engine is the only writer. apps/sipd is the only reader, and it reads on the hot path of a
// SUBSCRIBE and of every state-change NOTIFY — which is why State is a resolved top-level field
// rather than something a reader re-derives from Contributors.

// PresenceDeviceState is the value a busy-lamp key renders. It mirrors packages/telephony's
// DEVICE_STATES, in the same order.
//
// Closed rather than an open string, unlike the channel state in the `channels` bucket. A wallboard
// renders a channel state as text and degrades gracefully; sipd MAPS this onto RFC 4235
// dialog-info+xml and has no degradation available — an unrecognised value is a NOTIFY it cannot
// compose, which is a lamp stuck on whatever it last showed.
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
	// PresenceDeviceStateHangup is every channel hung up and not yet reaped. The edge a phone needs
	// in order to clear its lamp; the publisher follows it with `down`.
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
func (v PresenceDeviceState) Valid() bool {
	for _, candidate := range PresenceDeviceStateValues {
		if v == candidate {
			return true
		}
	}
	return false
}

func (v PresenceDeviceState) String() string { return string(v) }

// ExtensionPresence is one extension's aggregated device state, as the `presence` bucket holds it.
//
// The engine derives it from the SHARED `channels` bucket rather than from any one instance's
// in-memory registry, so every replica computes the same value and last-write-wins is redundancy
// rather than conflict. Writers debounce on VALUE — an entry is rewritten only when the aggregate
// changes — which is what lets this reader turn one KV update into exactly one NOTIFY.
//
// Absence is meaningful and is not the same as a `down` value: the engine deletes the key when an
// extension has no live channels, and the bucket's five-minute TTL produces the same effect
// unprompted. A reader must clear a lamp on both.
type ExtensionPresence struct {
	OrgID string `json:"orgId"`
	// ExtensionNumber is the dialable number, e.g. "1001" — the KV key's second token. The NUMBER
	// and not the extension row id, because that is what a BLF key is provisioned against and
	// therefore what arrives on a SUBSCRIBE.
	ExtensionNumber string              `json:"extensionNumber"`
	State           PresenceDeviceState `json:"state"`
	// ChannelCount is how many live channels the aggregation saw. 0 whenever State is `down`.
	ChannelCount int `json:"channelCount"`
	// CallStates are the per-channel packages/telephony CallState values the aggregation collapsed,
	// carried for diagnosis. An INPUT the writer already consumed, never something to act on.
	CallStates []string `json:"callStates,omitempty"`
	// WrittenBy is the engine instance that last wrote the entry. Not part of the answer — every
	// instance computes the same one — but it is how an operator tells which replica is still alive.
	WrittenBy string `json:"writtenBy,omitempty"`
	// UpdatedAt is epoch milliseconds, matching every other KV value on this backbone.
	UpdatedAt int64 `json:"updatedAt"`
}
