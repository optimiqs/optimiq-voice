// Package events is the Go half of the Optimiq Voice NATS backbone contract (plan §3.5).
//
// It is the peer of the TypeScript package @optimiq-voice/events. TypeScript is the single source
// of truth; this package is partly generated from it and partly hand-written against it:
//
//	*_gen.go        GENERATED from packages/events/src via packages/events/schema (JSON Schema).
//	                Payload structs, closed vocabularies, the event-type registry. Do not edit.
//	subjects.go     HAND-WRITTEN mirror of src/subjects.ts — the subject taxonomy, its builders,
//	                its parser, and the AOR hashing rule.
//	streams.go      HAND-WRITTEN mirror of src/streams.ts — JetStream stream and KV bucket
//	                definitions, and the KV key builders.
//	envelope.go     HAND-WRITTEN mirror of src/schemas/envelope.ts — the generic envelope and its
//	                constructors.
//
// The hand-written half cannot be generated (subject assembly, hashing and NATS-style subject
// matching are behaviour, not shape), so it is instead PROVEN equivalent: `packages/events`
// codegen emits testdata/parity.json from the live TypeScript implementation, and the tests here
// assert every builder, filter, parse result, KV key, stream definition and vocabulary against it.
// A change on either side that is not mirrored fails `go test ./...` before it can reach a broker.
//
// This package opens no connections and wraps no client. Applications use nats.go (or the NestJS
// NATS transport on the TypeScript side) against the definitions exported here.
//
// # Regenerating
//
//	pnpm --filter @optimiq-voice/events codegen        # rewrite schema/ and packages/events-go
//	pnpm --filter @optimiq-voice/events codegen:check  # CI drift gate: fails on any diff
package events
