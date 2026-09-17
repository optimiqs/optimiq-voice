package registrar

import (
	"context"
	"strings"

	location "github.com/optimiqs/optimiq-voice/apps/sipd/internal/aor"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
)

// ConnectionProbe reports whether the transport layer still holds the connection a binding was
// established over. Implemented over sipgo's transport layer in cmd/sipd; a seam so this package
// tests without a socket.
type ConnectionProbe interface {
	// Connected answers for one `network` (sipgo's transport name) and one peer `host:port`,
	// which is the same string the registrar stored as the contact's SourceAddress.
	Connected(network, address string) bool
}

// connectionBound reports whether a binding on this transport lives and dies with its connection.
//
// RFC 7118 §5.2: a WebSocket contact is reachable only over the connection that registered it —
// the URI carries a `gr` instance and no dialable host, so there is nothing to re-dial. A browser
// tab that closes therefore leaves a binding that can never be reached again, and every fork to it
// is a wasted INVITE and (per E2E-routing P1-2) an extra CDR leg.
//
// TCP and TLS are deliberately NOT included. Their contacts carry a routable address, a client may
// legitimately let a connection idle out between calls, and sipgo will open a new one to deliver an
// INVITE — so reaping a TCP binding on connection close would de-register working phones.
func connectionBound(transport string) bool {
	switch strings.ToLower(transport) {
	case "ws", "wss":
		return true
	default:
		return false
	}
}

// SweepUnreachable removes connection-bound contacts whose socket is gone and publishes the
// deregistration, so presence and the live registrations view stop showing a closed browser tab as
// a reachable device. It returns how many contacts it removed.
//
// Only contacts THIS instance granted are considered: `sipdInstanceId` is stamped on every contact
// for exactly this reason, and a fleet member that reaped a peer's WebSocket bindings would be
// answering a question about a socket it has never had.
func (r *Registrar) SweepUnreachable(ctx context.Context) int {
	if r.connections == nil {
		return 0
	}
	r.mu.Lock()
	tracked := make([]kv.Binding, 0, len(r.tracked))
	for _, binding := range r.tracked {
		if r.hasUnreachableContact(binding) {
			tracked = append(tracked, binding)
		}
	}
	r.mu.Unlock()

	removed := 0
	for _, hint := range tracked {
		before, after, err := r.bindings.Update(ctx, hint.OrgID, hint.AORHash, func(previous *kv.Binding) (*kv.Binding, error) {
			if previous == nil {
				return nil, nil
			}
			// Re-checked inside the CAS: a device that re-registered between the filter and the
			// write has a live connection again and must not be unbound by a stale reading.
			live := location.FromBinding(*previous)
			changed := false
			for _, contact := range live.Contacts() {
				if !r.unreachable(contact) {
					continue
				}
				live, _ = live.Unbind(contact.Key(), r.now())
				changed = true
			}
			if !changed {
				return previous, nil
			}
			return bindingForSet(*previous, live, r.now()), nil
		})
		if err != nil {
			r.log.Error("cannot sweep an unreachable registration", "error", err)
			continue
		}
		trackedBefore := before
		if trackedBefore == nil {
			trackedBefore = &hint
		}
		r.trackChange(hint.OrgID, hint.AORHash, trackedBefore, after)
		for _, contact := range removedContacts(before, after) {
			// `client` and not `expired`: the binding did not lapse, the client's connection went
			// away, which is the same fact an explicit `Expires: 0` reports one message earlier.
			r.publishRemoved(ctx, hint, contact, false)
			r.log.Info("removed a registration whose connection closed",
				"aor", hint.AOR, "contact", contact.URI,
				"transport", contact.Transport, "source", contact.SourceAddress)
			removed++
		}
	}
	return removed
}

// hasUnreachableContact reports whether a binding holds anything worth a KV round trip.
func (r *Registrar) hasUnreachableContact(binding kv.Binding) bool {
	for _, contact := range location.FromBinding(binding).Contacts() {
		if r.unreachable(contact) {
			return true
		}
	}
	return false
}

// unreachable reports whether this contact's connection is provably gone.
func (r *Registrar) unreachable(contact location.Contact) bool {
	if !connectionBound(contact.Transport) || contact.SourceAddress == "" {
		return false
	}
	if contact.SIPDInstanceID != r.instanceID {
		return false
	}
	return !r.connections.Connected(contact.Transport, contact.SourceAddress)
}
