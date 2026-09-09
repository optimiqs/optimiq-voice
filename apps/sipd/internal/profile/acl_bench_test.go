package profile

import (
	"fmt"
	"testing"
)

// Match runs once per unauthenticated INVITE, on a path whose rate an attacker controls, so its
// cost must stay flat and allocation free at realistic ACL sizes.

func benchACL(b *testing.B, size int) *ACL {
	b.Helper()
	entries := make([]Entry, 0, size)
	for index := range size {
		entry, err := ParseEntry(
			fmt.Sprintf("203.%d.%d.0/24", index/256, index%256),
			ActionAllow, index, fmt.Sprintf("trunk-%d", index), "bench")
		if err != nil {
			b.Fatal(err)
		}
		entries = append(entries, entry)
	}
	return NewACL(entries)
}

// BenchmarkACLMatchHit measures the worst hit: the entry that sorts last, so the walk is complete.
func BenchmarkACLMatchHit(b *testing.B) {
	for _, size := range []int{8, 64, 512} {
		b.Run(fmt.Sprintf("entries=%d", size), func(b *testing.B) {
			acl := benchACL(b, size)
			source := "203.0.0.7:5060"
			b.ReportAllocs()
			for b.Loop() {
				if _, allowed := acl.Match(source); !allowed {
					b.Fatalf("%s should match", source)
				}
			}
		})
	}
}

// BenchmarkACLMatchMiss measures an address in no entry, which walks every one.
func BenchmarkACLMatchMiss(b *testing.B) {
	for _, size := range []int{8, 64, 512} {
		b.Run(fmt.Sprintf("entries=%d", size), func(b *testing.B) {
			acl := benchACL(b, size)
			b.ReportAllocs()
			for b.Loop() {
				if _, allowed := acl.Match("198.51.100.7:5060"); allowed {
					b.Fatal("an address outside every entry must be refused")
				}
			}
		})
	}
}
