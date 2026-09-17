// Package netbuf sizes datagram socket buffers for the data plane.
//
// A socket left at the kernel default drops bursts inside the kernel, invisibly to the read loop;
// sizing the buffers explicitly and reporting what the kernel granted makes that loss observable.
package netbuf

import (
	"fmt"
	"net"
)

// Sizes is what a socket ended up with, in bytes. Linux doubles a requested SO_RCVBUF and clamps it
// to net.core.rmem_max, so the granted size routinely differs from the requested one.
type Sizes struct {
	Receive int
	Send    int
}

// Tune sets the receive and send buffers on a UDP socket and reports what the kernel granted.
//
// A non-positive size leaves that direction at the kernel default; a refused request is returned as
// an error rather than swallowed.
func Tune(conn *net.UDPConn, receive, send int) (Sizes, error) {
	if conn == nil {
		return Sizes{}, fmt.Errorf("netbuf: a connection is required")
	}
	if receive > 0 {
		if err := conn.SetReadBuffer(receive); err != nil {
			return Sizes{}, fmt.Errorf("netbuf: setting SO_RCVBUF to %d: %w", receive, err)
		}
	}
	if send > 0 {
		if err := conn.SetWriteBuffer(send); err != nil {
			return Sizes{}, fmt.Errorf("netbuf: setting SO_SNDBUF to %d: %w", send, err)
		}
	}
	return granted(conn)
}
