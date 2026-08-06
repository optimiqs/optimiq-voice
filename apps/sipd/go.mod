module github.com/optimiqs/optimiq-voice/apps/sipd

go 1.26

require (
	github.com/emiago/sipgo v1.4.3
	github.com/icholy/digest v1.1.0
	github.com/nats-io/nats.go v1.52.0
	github.com/optimiqs/optimiq-voice/packages/events-go v0.0.0
)

require (
	github.com/gobwas/httphead v0.1.0 // indirect
	github.com/gobwas/pool v0.2.1 // indirect
	github.com/gobwas/ws v1.3.2 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/klauspost/compress v1.18.5 // indirect
	github.com/nats-io/nkeys v0.4.15 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	golang.org/x/crypto v0.49.0 // indirect
	golang.org/x/sync v0.16.0 // indirect
	golang.org/x/sys v0.42.0 // indirect
)

// The contract package is developed in lockstep with this service and is not published; the
// workspace resolves it for day-to-day work and this replace keeps `go build` inside apps/sipd
// working on its own (GOWORK=off, and any CI job that builds one module at a time).
replace github.com/optimiqs/optimiq-voice/packages/events-go => ../../packages/events-go
