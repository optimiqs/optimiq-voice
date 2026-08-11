module github.com/optimiqs/optimiq-voice/apps/mediad

go 1.26

require (
	github.com/nats-io/nats.go v1.52.0
	github.com/optimiqs/optimiq-voice/packages/events-go v0.0.0-00010101000000-000000000000
	github.com/pion/rtp v1.10.5
	github.com/pion/sdp/v3 v3.0.19
)

require (
	github.com/google/uuid v1.6.0 // indirect
	github.com/klauspost/compress v1.18.5 // indirect
	github.com/nats-io/nkeys v0.4.15 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	golang.org/x/crypto v0.52.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
)

// The contract package is developed in lockstep with this service and is not published; the
// workspace resolves it for day-to-day work and this replace keeps `go build` inside apps/mediad
// working on its own (GOWORK=off, and any CI job that builds one module at a time).
replace github.com/optimiqs/optimiq-voice/packages/events-go => ../../packages/events-go
