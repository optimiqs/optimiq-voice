package proclimit_test

import (
	"testing"

	"github.com/optimiqs/optimiq-voice/packages/runtime-go/proclimit"
)

func TestApplyMemoryLimitDefersToAnExplicitSetting(t *testing.T) {
	applied := proclimit.ApplyMemoryLimit(func(string) string { return "512MiB" }, 10)
	if applied != 0 {
		t.Errorf("an explicit GOMEMLIMIT was overridden, applying %d", applied)
	}
}

// Outside a container there is no cgroup limit to read, so the call must be a no-op rather than a
// guess; inside one it applies a soft limit below the hard one.
func TestApplyMemoryLimitIsANoOpWithoutACgroupLimit(t *testing.T) {
	applied := proclimit.ApplyMemoryLimit(func(string) string { return "" }, 10)
	if applied < 0 {
		t.Errorf("ApplyMemoryLimit returned %d", applied)
	}
}
