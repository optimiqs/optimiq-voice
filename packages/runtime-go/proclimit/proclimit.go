// Package proclimit makes a Go data-plane process aware of the limits its container was given.
//
// The runtime already derives GOMAXPROCS from the cgroup CPU limit, but GOMEMLIMIT has no such
// default: setting a soft limit below the container's hard limit turns an OOM kill into recoverable
// GC pressure.
package proclimit

import (
	"os"
	"runtime/debug"
	"strconv"
	"strings"
)

// DefaultHeadroomPercent is the share of the container's memory limit left to everything that is not
// the Go heap: stacks, runtime bookkeeping, and the slack a collector needs to finish a cycle.
const DefaultHeadroomPercent = 10

// ApplyMemoryLimit sets GOMEMLIMIT from the cgroup memory limit, leaving headroom, and reports the
// value it applied. It returns 0 when it changed nothing.
//
// It defers to an explicit GOMEMLIMIT in the environment, which the runtime has already honoured,
// and does nothing when the cgroup reports no limit.
func ApplyMemoryLimit(getenv func(string) string, headroomPercent int) int64 {
	if strings.TrimSpace(getenv("GOMEMLIMIT")) != "" {
		return 0
	}
	limit, ok := cgroupMemoryLimit()
	if !ok {
		return 0
	}
	if headroomPercent < 0 || headroomPercent >= 100 {
		headroomPercent = DefaultHeadroomPercent
	}
	soft := limit - limit/100*int64(headroomPercent)
	if soft <= 0 {
		return 0
	}
	debug.SetMemoryLimit(soft)
	return soft
}

// cgroupMemoryLimit reads the container's memory ceiling in bytes, v2 first and then v1.
//
// "max" in v2 and the huge sentinel in v1 both mean "no limit" and are rejected: deriving a soft
// limit from them would set GOMEMLIMIT to most of the host's address space.
func cgroupMemoryLimit() (int64, bool) {
	for _, path := range []string{
		"/sys/fs/cgroup/memory.max",
		"/sys/fs/cgroup/memory/memory.limit_in_bytes",
	} {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		text := strings.TrimSpace(string(raw))
		if text == "max" {
			continue
		}
		value, err := strconv.ParseInt(text, 10, 64)
		if err != nil || value <= 0 || value > 1<<50 {
			continue
		}
		return value, true
	}
	return 0, false
}
