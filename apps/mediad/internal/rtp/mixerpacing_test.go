package rtp_test

import (
	"testing"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// One mixer tick is 20 ms of MEDIA time, not one packet. An SDP ptime is the packetisation a party
// prefers to send, not permission to truncate what it actually sent (RFC 3264 §6.1), so a room has
// to mix 10, 20, 30 and 60 ms members against each other without any of them drifting.
//
// These assertions read the FIRST sample of each mixed frame, which on the room's clock is media
// sample `tick * FrameSamples` of the sender's stream. Consuming a packet per tick puts a different
// packet's level there for every packetisation but 20 ms, so the expectations below are exactly
// what separates media-time pacing from packet pacing.

// packetise sends `len(levels)` packets of `samplesPerPacket` µ-law samples each, packet i carrying
// the constant level levels[i], and waits for them all to reach the member's jitter buffer. It
// answers the levels as they survive the codec, which is what the mix arithmetic is exact against.
func (r *confRig) packetise(t *testing.T, index, samplesPerPacket int, levels []int16) []int16 {
	t.Helper()

	exact := make([]int16, len(levels))
	for packet, level := range levels {
		encoded := audio.LinearToULaw(level)
		exact[packet] = audio.ULawToLinear(encoded)
		payload := make([]byte, samplesPerPacket)
		for i := range payload {
			payload[i] = encoded
		}
		r.phones[index].send(t, pionrtp.Packet{
			Header: pionrtp.Header{
				Version:        2,
				PayloadType:    rtp.PayloadTypePCMU,
				SSRC:           uint32(1000 + index),
				SequenceNumber: uint16(packet + 1),
				Timestamp:      uint32((packet + 1) * samplesPerPacket),
			},
			Payload: payload,
		})
	}

	r.awaitPushed(t, index, uint64(len(levels)))
	return exact
}

// latch makes a member's socket known to its session without giving the mix anything to play: one
// packet is below the jitter buffer's priming depth, so the member is a listener that can be
// written to. A session with no remote address yet has nothing to send a mixed frame to.
func (r *confRig) latch(t *testing.T, index int) {
	t.Helper()
	r.phones[index].send(t, pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    rtp.PayloadTypePCMU,
			SSRC:           uint32(1000 + index),
			SequenceNumber: 1,
			Timestamp:      audio.FrameTimestampStep,
		},
		Payload: make([]byte, audio.FrameSamples),
	})
	r.awaitPushed(t, index, 1)
}

// awaitPushed blocks until a member's jitter buffer has accepted `count` packets, so a tick driven
// by hand cannot outrun the read loop.
func (r *confRig) awaitPushed(t *testing.T, index int, count uint64) {
	t.Helper()
	session, ok := r.manager.Get(r.ids[index])
	if !ok {
		t.Fatalf("session %s is gone", r.ids[index])
	}
	waitFor(t, "the member's packets reached its jitter buffer", func() bool {
		member := session.MixMember()
		return member != nil && member.JitterStats().Pushed >= count
	})
}

func TestATickConsumesTwentyMillisecondsOfMediaWhateverThePacketisation(t *testing.T) {
	// A speaker and a silent listener, so what the listener hears IS the speaker's stream. Each of
	// the speaker's packets carries its own level, so the level heard on tick k names the packet
	// that media sample k*FrameSamples fell in — the whole question this fix is about.
	const ticks = 6

	for _, sender := range []struct {
		name             string
		portLow          int
		samplesPerPacket int
		packets          int
		// wantPacket[k] is the packet the first sample of tick k belongs to, by media time.
		wantPacket []int
	}{
		{
			name: "ten millisecond packets", portLow: 59800, samplesPerPacket: audio.FrameSamples / 2,
			packets: 16, wantPacket: []int{0, 2, 4, 6, 8, 10},
		},
		{
			name: "twenty millisecond packets", portLow: 59820, samplesPerPacket: audio.FrameSamples,
			packets: 10, wantPacket: []int{0, 1, 2, 3, 4, 5},
		},
		{
			name: "thirty millisecond packets", portLow: 59840, samplesPerPacket: audio.FrameSamples * 3 / 2,
			packets: 8, wantPacket: []int{0, 0, 1, 2, 2, 3},
		},
		{
			name: "sixty millisecond packets", portLow: 59860, samplesPerPacket: audio.FrameSamples * 3,
			packets: 6, wantPacket: []int{0, 0, 0, 1, 1, 1},
		},
	} {
		t.Run(sender.name, func(t *testing.T) {
			rig := newConfRig(t, sender.portLow, sender.portLow+19, 2)
			rig.join(t, "room-pacing")

			levels := make([]int16, sender.packets)
			for packet := range levels {
				// Spaced far wider than one µ-law step, so a frame taken from the wrong packet is
				// unmistakable rather than a rounding argument.
				levels[packet] = int16(2000 * (packet + 1))
			}
			exact := rig.packetise(t, 0, sender.samplesPerPacket, levels)
			rig.latch(t, 1)

			for tick := range ticks {
				rig.tick(t)
				got, ok := rig.heard(t, 1)
				if !ok {
					t.Fatalf("tick %d: the listener heard nothing; the room is off its clock", tick)
				}
				want := exact[sender.wantPacket[tick]]
				if !closeEnough(got, want) {
					t.Errorf("tick %d: the listener heard %d, want %d (packet %d, the one media "+
						"sample %d falls in)", tick, got, want, sender.wantPacket[tick],
						tick*audio.FrameSamples)
				}
			}
		})
	}
}

func TestOneRoomMixesMembersOnDifferentPacketisations(t *testing.T) {
	// Four members, four packetisations, every one of them talking at a constant level. Constant
	// levels make the expected sum independent of alignment, so what this asserts is that nobody
	// runs dry: a member consumed a packet per tick would exhaust three times as fast as the room's
	// clock at 60 ms and fall out of the mix.
	const ticks = 8

	rig := newConfRig(t, 59880, 59899, 4)
	rig.join(t, "room-mixed")

	members := []struct {
		samplesPerPacket int
		packets          int
		level            int16
	}{
		{samplesPerPacket: audio.FrameSamples / 2, packets: 18, level: 2000},
		{samplesPerPacket: audio.FrameSamples, packets: 10, level: 4000},
		{samplesPerPacket: audio.FrameSamples * 3 / 2, packets: 7, level: 6000},
		{samplesPerPacket: audio.FrameSamples * 3, packets: 4, level: 8000},
	}

	exact := make([]int16, len(members))
	for index, member := range members {
		levels := make([]int16, member.packets)
		for packet := range levels {
			levels[packet] = member.level
		}
		exact[index] = rig.packetise(t, index, member.samplesPerPacket, levels)[0]
	}

	for tick := range ticks {
		rig.tick(t)
		for index := range members {
			want := int16(0)
			for other := range members {
				if other != index {
					want += exact[other]
				}
			}
			got, ok := rig.heard(t, index)
			if !ok {
				t.Fatalf("tick %d: member %d heard nothing", tick, index)
			}
			if !closeEnough(got, want) {
				t.Errorf("tick %d: member %d heard %d, want %d (the sum of the other three, every "+
					"tick, however they packetise)", tick, index, got, want)
			}
		}
	}
}

func TestMediaTimePacingSurvivesReorderingAndLoss(t *testing.T) {
	// 30 ms packets delivered out of order with one never sent. The buffer reorders, the missing
	// media time is silence rather than a stall, and the stream picks up where it left off: pacing
	// by media time must not turn one lost packet into a permanently skewed member.
	const (
		samplesPerPacket = audio.FrameSamples * 3 / 2
		packets          = 10
		lost             = 4
		ticks            = 8
	)

	rig := newConfRig(t, 59900, 59919, 2)
	rig.join(t, "room-loss")

	const level = int16(6000)
	encoded := audio.LinearToULaw(level)
	exact := audio.ULawToLinear(encoded)
	payload := make([]byte, samplesPerPacket)
	for i := range payload {
		payload[i] = encoded
	}

	// Every neighbouring pair swapped, and one packet dropped outright.
	order := make([]int, 0, packets)
	for packet := 0; packet < packets; packet += 2 {
		order = append(order, packet+1, packet)
	}
	sent := uint64(0)
	for _, packet := range order {
		if packet == lost || packet >= packets {
			continue
		}
		rig.phones[0].send(t, pionrtp.Packet{
			Header: pionrtp.Header{
				Version:        2,
				PayloadType:    rtp.PayloadTypePCMU,
				SSRC:           1000,
				SequenceNumber: uint16(packet + 1),
				Timestamp:      uint32((packet + 1) * samplesPerPacket),
			},
			Payload: payload,
		})
		sent++
	}
	rig.awaitPushed(t, 0, sent)
	rig.latch(t, 1)

	heard := 0
	for tick := range ticks {
		rig.tick(t)
		got, ok := rig.heard(t, 1)
		if !ok {
			t.Fatalf("tick %d: the listener heard nothing; loss must not stop the room's clock", tick)
		}
		switch {
		case closeEnough(got, exact):
			heard++
		case closeEnough(got, 0):
			// The 30 ms the lost packet carried, spread across the ticks it covered.
		default:
			t.Errorf("tick %d: the listener heard %d, which is neither the speaker's level %d nor "+
				"the silence a lost packet leaves", tick, got, exact)
		}
	}
	// One lost 30 ms packet can touch at most two of the room's 20 ms frames.
	if want := ticks - 2; heard < want {
		t.Errorf("the listener heard the speaker on %d of %d ticks, want at least %d; one lost "+
			"packet has skewed the stream rather than costing its own media time", heard, ticks, want)
	}
}
