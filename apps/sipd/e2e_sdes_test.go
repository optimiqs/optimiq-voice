//go:build e2e

package sipd_test

import (
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"
)

func mean(values []float64) float64 {
	total := 0.0
	for _, value := range values {
		total += value
	}
	return total / float64(len(values))
}

const mediadMetrics = "http://127.0.0.1:9291/metrics"

// artifact writes evidence next to the run when SIPD_E2E_ARTIFACTS names a directory.
func artifact(t *testing.T, name, body string) {
	t.Helper()
	dir := os.Getenv("SIPD_E2E_ARTIFACTS")
	if dir == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Logf("artifact dir: %v", err)
		return
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Logf("artifact %s: %v", name, err)
	}
}

// mediadCounter reads one Prometheus sample from the running mediad.
func mediadCounter(t *testing.T, sample string) float64 {
	t.Helper()
	response, err := http.Get(mediadMetrics)
	if err != nil {
		t.Fatalf("mediad /metrics: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("mediad /metrics body: %v", err)
	}
	for line := range strings.SplitSeq(string(body), "\n") {
		if !strings.HasPrefix(line, sample) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		value, err := strconv.ParseFloat(fields[1], 64)
		if err == nil {
			return value
		}
	}
	t.Fatalf("mediad /metrics has no sample %q", sample)
	return 0
}

// ulawEnergy is the mean absolute amplitude of a buffer read as G.711 µ-law. A 660 Hz tone at the
// amplitude the harness sends reads around 5 000; ciphertext, being uniform bytes, reads far lower
// and — this is the discriminator — is not periodic.
func ulawEnergy(payload []byte) float64 {
	if len(payload) == 0 {
		return 0
	}
	total := 0.0
	for _, sample := range payload {
		decoded := sipua.ULawDecode(sample)
		total += math.Abs(float64(decoded))
	}
	return total / float64(len(payload))
}

// ulawZeroCrossings counts sign changes in a buffer read as G.711 µ-law, per 160-sample frame.
// This is the discriminator energy cannot give: a 660 Hz tone at 8 kHz crosses zero about 26 times
// in a 20 ms frame, while uniformly random bytes cross about 80 times. Ciphertext is uniform.
func ulawZeroCrossings(payload []byte) float64 {
	if len(payload) < 2 {
		return 0
	}
	crossings := 0
	previous := sipua.ULawDecode(payload[0])
	for _, sample := range payload[1:] {
		decoded := sipua.ULawDecode(sample)
		if (decoded < 0) != (previous < 0) {
			crossings++
		}
		previous = decoded
	}
	return float64(crossings) * 160 / float64(len(payload))
}

// TestE2ESDESKeyDerivationMatchesRFC3711 pins the harness's own SRTP against the published test
// vector before it is used as evidence about the platform. RFC 3711 §B.3.
func TestE2ESDESKeyDerivationMatchesRFC3711(t *testing.T) {
	masterKey, _ := hex.DecodeString("E1F97A0D3E018BE0D64FA32C06DE4139")
	masterSalt, _ := hex.DecodeString("0EC675AD498AFEEBB6960B3AABE6")
	session, err := sipua.NewSRTPSession(append(append([]byte{}, masterKey...), masterSalt...))
	if err != nil {
		t.Fatalf("deriving: %v", err)
	}
	for name, want := range map[string]string{
		"cipher key":  "C61E7A93744F39EE10734AFE3FF7A087",
		"auth key":    "CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4",
		"cipher salt": "30CBBC08863D8C85D49DB34A9AE1",
	} {
		got := hex.EncodeToString(session.DerivedKey(name))
		if !strings.EqualFold(got, want) {
			t.Errorf("%s = %s, RFC 3711 §B.3 says %s", name, got, want)
		}
	}
}

// TestE2ESDESOverTLS signals a call over TLS 5161 offering RFC 4568 SDES and proves three things
// about the media that comes back: the answer negotiates SDES, the RTP on the wire is encrypted,
// and plaintext RTP aimed at the SRTP port is dropped.
func TestE2ESDESOverTLS(t *testing.T) {
	requireE2E(t)
	callerPassword := e2ePassword(t, "1601")
	calleePassword := e2ePassword(t, "1602")

	// The callee is an ordinary plain-RTP phone: SRTP is per leg, and the B-leg staying clear is
	// what makes a decrypted A-leg visible as audible tone at the far end.
	callee := newPhone(t, "1602", calleePassword)

	caller := dial(t, sipua.TLS, e2eTLS, "1601", callerPassword)
	caller.Timeout = 20 * time.Second
	if response, err := caller.Register(sipua.RegisterOptions{Expires: 300}); err != nil || response.StatusCode != 200 {
		t.Fatalf("1601 REGISTER over TLS: %v / %v", response, err)
	}
	callerMedia, err := sipua.NewRTPEndpoint()
	if err != nil {
		t.Fatalf("binding the caller's RTP socket: %v", err)
	}
	t.Cleanup(func() { _ = callerMedia.Close() })

	localKey := sipua.NewSRTPKeyMaterial()
	offer := callerMedia.OfferSDPSDES("sendrecv", 1, localKey)
	t.Logf("OFFER (caller -> sipd over TLS %s):\n%s", e2eTLS, offer)
	artifact(t, "offer.sdp", offer)

	droppedBefore := mediadCounter(t, `mediad_rtp_packets_dropped_total{reason="malformed"}`)
	receivedBefore := mediadCounter(t, "mediad_rtp_packets_received_total")

	type inbound struct {
		dialog *sipua.Dialog
		err    error
	}
	inbounds := make(chan inbound, 1)
	go func() {
		_, dialog, err := callee.ua.AwaitInvite()
		inbounds <- inbound{dialog, err}
	}()

	callerDialog, err := caller.InviteAsync("sip:1602@"+e2eRealm, offer)
	if err != nil {
		t.Fatalf("INVITE over TLS: %v", err)
	}
	arrival := <-inbounds
	if arrival.err != nil {
		t.Fatalf("the callee never saw the INVITE: %v", arrival.err)
	}
	calleeDialog := arrival.dialog
	if err := calleeDialog.Respond(180, "Ringing", ""); err != nil {
		t.Fatalf("180: %v", err)
	}
	if err := calleeDialog.Respond(200, "OK", callee.media.OfferSDP("sendrecv")); err != nil {
		t.Fatalf("200: %v", err)
	}
	response, provisional, err := callerDialog.AwaitFinal()
	if err != nil {
		t.Fatalf("no final response: %v", err)
	}
	if response.StatusCode/100 != 2 {
		artifact(t, "answer-refused.txt", fmt.Sprintf("%d %s\n\n%s", response.StatusCode, response.Reason, response.Body()))
		t.Fatalf("the SDES INVITE was answered %d %s (provisional %v); body:\n%s",
			response.StatusCode, response.Reason, provisional, response.Body())
	}
	if err := callerDialog.Ack(); err != nil {
		t.Fatalf("ACK: %v", err)
	}
	answer := callerDialog.RemoteSDP
	t.Logf("ANSWER (platform -> caller):\n%s", answer)
	artifact(t, "answer.sdp", answer)

	// ---- Claim 1: the answer negotiated SDES ----------------------------------------------
	proto := sipua.MediaProto(answer)
	tag, remoteKey, found := sipua.CryptoAttribute(answer)
	t.Logf("CLAIM 1 — answer m= proto %q; a=crypto present: %v (tag %d)", proto, found, tag)
	if !found {
		t.Fatalf("CLAIM 1 FAIL: the answer carries no usable a=crypto line:\n%s", answer)
	}
	if proto != "RTP/SAVP" {
		t.Errorf("CLAIM 1 PARTIAL: a=crypto is present but the m= line says %q, not RTP/SAVP", proto)
	}
	if tag != 1 {
		t.Errorf("CLAIM 1: the answer must echo the offered crypto tag 1, got %d (RFC 4568 §5.1.2)", tag)
	}

	target, ok := sipua.MediaTarget(answer)
	if !ok {
		t.Fatalf("no media target in the answer:\n%s", answer)
	}
	calleeTarget, ok := sipua.MediaTarget(calleeDialog.RemoteSDP)
	if !ok {
		t.Fatalf("no media target for the callee:\n%s", calleeDialog.RemoteSDP)
	}
	t.Logf("media targets: caller -> %s (SRTP), callee -> %s (plain)", target, calleeTarget)

	send, err := sipua.NewSRTPSession(localKey)
	if err != nil {
		t.Fatalf("send context: %v", err)
	}
	receive, err := sipua.NewSRTPSession(remoteKey)
	if err != nil {
		t.Fatalf("receive context: %v", err)
	}
	callerMedia.SetInspector(func(packet []byte) []byte {
		plain, err := receive.Unprotect(packet)
		if err != nil {
			return nil
		}
		return plain
	}, 8)

	callerSender, err := callerMedia.Sender(target)
	if err != nil {
		t.Fatalf("caller sender: %v", err)
	}
	callerSender.SetProtector(send.Protect)
	calleeSender, err := callee.media.Sender(calleeTarget)
	if err != nil {
		t.Fatalf("callee sender: %v", err)
	}

	// ---- Claim 2: what is on the wire is encrypted -----------------------------------------
	done := make(chan struct{})
	go func() { _, _ = calleeSender.SendTone(440, 2*time.Second); close(done) }()
	sent, err := callerSender.SendTone(660, 2*time.Second)
	if err != nil {
		t.Fatalf("caller SRTP tone: %v", err)
	}
	<-done
	time.Sleep(300 * time.Millisecond)

	callerStats := callerMedia.Stats()
	calleeStats := callee.media.Stats()
	t.Logf("caller sent %d SRTP packets; caller received %+v", sent, callerStats)
	t.Logf("callee (plain leg) received %+v", calleeStats)

	dump := &strings.Builder{}
	var wireCrossings, plainCrossings []float64
	for index, packet := range callerMedia.Raw() {
		payload := packet
		if len(payload) > 12 {
			payload = payload[12:]
		}
		fmt.Fprintf(dump, "packet %d: %d bytes on the wire (%d header + %d payload+tag)\n",
			index, len(packet), 12, len(payload))
		fmt.Fprintf(dump, "  wire bytes            : %s\n", hex.EncodeToString(packet))
		fmt.Fprintf(dump, "  ON THE WIRE read as µ-law : energy %.0f, %.0f zero crossings per frame\n",
			ulawEnergy(payload), ulawZeroCrossings(payload))
		if plain, err := receive.Unprotect(append([]byte(nil), packet...)); err == nil {
			wireCrossings = append(wireCrossings, ulawZeroCrossings(payload))
			plainCrossings = append(plainCrossings, ulawZeroCrossings(plain[12:]))
			fmt.Fprintf(dump, "  DECRYPTED with the answer's key: %d bytes, µ-law energy %.0f, %.0f zero crossings per frame\n",
				len(plain), ulawEnergy(plain[12:]), ulawZeroCrossings(plain[12:]))
		}
		dump.WriteString("\n")
		if index >= 3 {
			break
		}
	}
	t.Logf("CLAIM 2 — first packets received by the caller on the SRTP leg:\n%s", dump.String())
	artifact(t, "wire-packets.txt", dump.String())

	if len(plainCrossings) > 0 {
		wire, plain := mean(wireCrossings), mean(plainCrossings)
		t.Logf("CLAIM 2 — zero crossings per 20 ms frame: %.0f on the wire, %.0f after decryption "+
			"(a 660 Hz µ-law tone is ~26; uniform bytes are ~80)", wire, plain)
		if plain > 45 {
			t.Errorf("CLAIM 2 PARTIAL: the DECRYPTED audio is not a tone (%.0f crossings per frame)", plain)
		}
		if wire < 60 {
			t.Errorf("CLAIM 2 FAIL: the bytes ON THE WIRE read as periodic audio (%.0f crossings per frame) — this is not ciphertext", wire)
		}
	}
	if callerStats.Packets == 0 {
		t.Errorf("CLAIM 2 FAIL: nothing decrypted under the answer's key (%d datagrams refused authentication)",
			callerStats.Undecodable)
	} else {
		if callerStats.Undecodable > 0 {
			t.Errorf("CLAIM 2 PARTIAL: %d datagrams failed the auth tag while %d decrypted",
				callerStats.Undecodable, callerStats.Packets)
		}
		if callerStats.Energy == 0 {
			t.Error("CLAIM 2 PARTIAL: packets decrypted but carried silence")
		}
	}
	if calleeStats.Packets == 0 || calleeStats.Energy == 0 {
		t.Errorf("CLAIM 2 PARTIAL: the plain far end heard %d packets, energy %.0f — the platform did not decrypt our SRTP",
			calleeStats.Packets, calleeStats.Energy)
	}

	// ---- Claim 3: plaintext RTP into the SRTP port is dropped -------------------------------
	calleeBefore := callee.media.Stats().Packets
	callerSender.SetProtector(nil)
	plainSent, err := callerSender.SendTone(660, 1*time.Second)
	if err != nil {
		t.Fatalf("plaintext tone: %v", err)
	}
	time.Sleep(700 * time.Millisecond)
	calleeAfter := callee.media.Stats().Packets
	t.Logf("CLAIM 3 — sent %d PLAINTEXT RTP packets to the SRTP port %s; the far end went %d -> %d packets",
		plainSent, target, calleeBefore, calleeAfter)
	if calleeAfter > calleeBefore {
		t.Errorf("CLAIM 3 FAIL: %d plaintext packets reached the far end through an SRTP leg", calleeAfter-calleeBefore)
	}

	if bye, err := callerDialog.Bye(); err != nil || bye.StatusCode/100 != 2 {
		t.Logf("BYE: %v / %v", bye, err)
	}
	// The session counters are summed into the process metrics when the session ends.
	time.Sleep(2 * time.Second)
	droppedAfter := mediadCounter(t, `mediad_rtp_packets_dropped_total{reason="malformed"}`)
	receivedAfter := mediadCounter(t, "mediad_rtp_packets_received_total")
	summary := fmt.Sprintf(
		"mediad_rtp_packets_dropped_total{reason=\"malformed\"}: %.0f -> %.0f (delta %.0f)\n"+
			"mediad_rtp_packets_received_total: %.0f -> %.0f (delta %.0f)\n"+
			"caller sent %d SRTP + %d plaintext packets\n",
		droppedBefore, droppedAfter, droppedAfter-droppedBefore,
		receivedBefore, receivedAfter, receivedAfter-receivedBefore, sent, plainSent)
	t.Logf("mediad counters across the call:\n%s", summary)
	artifact(t, "mediad-counters.txt", summary)
}
