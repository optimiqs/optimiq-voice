//go:build unix

package netbuf

import (
	"net"
	"syscall"
)

// granted reads SO_RCVBUF and SO_SNDBUF back off the socket. A failure is not an error: the sizes
// are diagnostics, and a kernel that will not report them has still applied them.
func granted(conn *net.UDPConn) (Sizes, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return Sizes{}, nil
	}
	var sizes Sizes
	_ = raw.Control(func(fd uintptr) {
		if value, err := syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF); err == nil {
			sizes.Receive = value
		}
		if value, err := syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF); err == nil {
			sizes.Send = value
		}
	})
	return sizes, nil
}
