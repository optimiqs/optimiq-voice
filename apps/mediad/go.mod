module github.com/optimiqs/optimiq-voice/apps/mediad

go 1.26

require (
	github.com/nats-io/nats.go v1.52.0
	github.com/optimiqs/optimiq-voice/packages/events-go v0.0.0-00010101000000-000000000000
	github.com/optimiqs/optimiq-voice/packages/runtime-go v0.0.0
	github.com/pion/rtcp v1.2.17
	github.com/pion/rtp v1.10.5
	github.com/pion/sdp/v3 v3.0.19
	github.com/pion/webrtc/v4 v4.2.20
)

require (
	github.com/google/uuid v1.6.0 // indirect
	github.com/klauspost/compress v1.18.5 // indirect
	github.com/nats-io/nkeys v0.4.15 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/pion/datachannel v1.6.2 // indirect
	github.com/pion/dtls/v3 v3.1.8 // indirect
	github.com/pion/ice/v4 v4.4.2 // indirect
	github.com/pion/interceptor v0.1.48 // indirect
	github.com/pion/logging v0.2.4 // indirect
	github.com/pion/mdns/v2 v2.2.0 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/sctp v1.11.1 // indirect
	github.com/pion/srtp/v3 v3.0.13 // indirect
	github.com/pion/stun/v4 v4.0.0 // indirect
	github.com/pion/transport/v4 v4.1.0 // indirect
	github.com/pion/turn/v5 v5.1.0 // indirect
	github.com/wlynxg/anet v0.0.5 // indirect
	golang.org/x/crypto v0.52.0 // indirect
	golang.org/x/net v0.54.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
	golang.org/x/time v0.14.0 // indirect
)

// The contract package is developed in lockstep with this service and is not published; the
// workspace resolves it for day-to-day work and this replace keeps `go build` inside apps/mediad
// working on its own (GOWORK=off, and any CI job that builds one module at a time).
replace github.com/optimiqs/optimiq-voice/packages/events-go => ../../packages/events-go

replace github.com/optimiqs/optimiq-voice/packages/runtime-go => ../../packages/runtime-go
