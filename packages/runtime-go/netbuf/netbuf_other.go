//go:build !unix

package netbuf

import "net"

func granted(*net.UDPConn) (Sizes, error) { return Sizes{}, nil }
