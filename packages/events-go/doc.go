// Package events is the Go half of the Optimiq Voice NATS backbone contract.
//
// TypeScript (@optimiq-voice/events) is the single source of truth: the *_gen.go files are
// generated from it, while subjects.go, streams.go and envelope.go are hand-written mirrors of
// src/subjects.ts, src/streams.ts and src/schemas/envelope.ts. Subject assembly, AOR hashing and
// subject matching are behaviour rather than shape, so instead of being generated they are proven
// equivalent against testdata/parity.json, which the TypeScript codegen emits from the live
// implementation: an unmirrored change on either side fails `go test ./...`.
//
// This package opens no connections and wraps no client.
//
// Regenerate with `pnpm --filter @optimiq-voice/events codegen`
// (`codegen:check` is the CI drift gate).
package events
