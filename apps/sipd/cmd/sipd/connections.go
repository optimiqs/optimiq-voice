package main

import (
	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
)

// connectionSource is the half of sipgo's transport layer the probe uses. An interface so the
// probe's own behaviour can be tested without a socket; *sip.TransportLayer satisfies it.
type connectionSource interface {
	GetConnection(network, addr string) (sip.Connection, error)
}

// transportProbe answers "is that peer's connection still open?" from sipgo's transport layer.
//
// sipgo's own connection-close hook is private and already claimed by its transaction layer
// (NewTransactionLayer overwrites it on all four reliable transports), so this asks the connection
// pool instead: the pool entry for a peer is deleted when its read loop ends, which is what a closed
// browser tab produces. Polling from the registrar's existing sweep rather than reacting to the
// close costs at most one sweep interval of staleness and needs no fork of the library.
type transportProbe struct {
	source connectionSource
}

var _ registrar.ConnectionProbe = (*transportProbe)(nil)

func newTransportProbe(agent *sipgo.UserAgent) *transportProbe {
	if agent == nil {
		return &transportProbe{}
	}
	return &transportProbe{source: agent.TransportLayer()}
}

// Connected implements registrar.ConnectionProbe.
//
// GetConnection takes a reference on the connection it hands back, so the probe holds one for the
// length of the check and gives it back with Ref(-1) rather than TryClose. TryClose would CLOSE the
// socket if the probe happened to hold the last reference, and tearing down a peer's connection is
// the transport layer's business, not a probe's.
//
// A count that is not above the probe's own reference means nothing else holds this connection: it
// has been hard-closed (WSConnection.Close zeroes the count, which is why a torn-down connection
// can sit at a negative one) and the binding it carried is unreachable.
func (p *transportProbe) Connected(network, address string) bool {
	if p.source == nil {
		return true
	}
	connection, err := p.source.GetConnection(network, address)
	if err != nil || connection == nil {
		return false
	}
	live := connection.Ref(0) > 1
	connection.Ref(-1)
	return live
}
