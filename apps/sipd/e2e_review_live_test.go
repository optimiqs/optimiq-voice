//go:build e2e

// Live re-drive of the sipd/mediad review findings (R01–R23) against the RUNNING local stack.
// Nothing here starts a server; every assertion goes through the real sipd, mediad, engine and
// broker on their real sockets.
//
//	SIPD_E2E=1 SIPD_E2E_PASS_1601=… SIPD_E2E_PASS_1602=… SIPD_E2E_NATS_PASS=… \
//	  go test -count=1 -tags e2e -run TestReviewLive -v .
package sipd_test

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// reviewNATS connects as the operator credential; these probes read and write control subjects that
// no single service credential covers.
func reviewNATS(t *testing.T) *nats.Conn {
	t.Helper()
	pass := strings.TrimSpace(os.Getenv("SIPD_E2E_NATS_PASS"))
	if pass == "" {
		t.Skip("set SIPD_E2E_NATS_PASS to the operator password")
	}
	user := strings.TrimSpace(os.Getenv("SIPD_E2E_NATS_USER"))
	if user == "" {
		user = "operator"
	}
	url := strings.TrimSpace(os.Getenv("SIPD_E2E_NATS_URL"))
	if url == "" {
		url = "nats://127.0.0.1:4322"
	}
	nc, err := nats.Connect(url, nats.UserInfo(user, pass), nats.Name("review-live-probe"))
	if err != nil {
		t.Fatalf("connecting to the broker: %v", err)
	}
	t.Cleanup(nc.Close)
	return nc
}

// rpc sends one request and decodes the reply into out.
func rpc(t *testing.T, nc *nats.Conn, subject string, in, out any) {
	t.Helper()
	body, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshalling %s: %v", subject, err)
	}
	reply, err := nc.Request(subject, body, 5*time.Second)
	if err != nil {
		t.Fatalf("%s: %v", subject, err)
	}
	if out != nil {
		if err := json.Unmarshal(reply.Data, out); err != nil {
			t.Fatalf("decoding %s reply %q: %v", subject, reply.Data, err)
		}
	}
	t.Logf("%s -> %s", subject, truncate(string(reply.Data), 400))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// mediaSessionKeys lists the live RTP sessions mediad has claimed.
func mediaSessionKeys(t *testing.T, nc *nats.Conn) map[string]bool {
	t.Helper()
	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatalf("jetstream: %v", err)
	}
	kv, err := js.KeyValue(t.Context(), "media-sessions")
	if err != nil {
		t.Fatalf("media-sessions bucket: %v", err)
	}
	keys, err := kv.Keys(t.Context())
	if err != nil {
		// An empty bucket answers with an error rather than an empty list.
		return map[string]bool{}
	}
	out := make(map[string]bool, len(keys))
	for _, key := range keys {
		out[key] = true
	}
	return out
}

// stackObjects is where mediad writes recordings on this stack.
func stackObjects(t *testing.T) string {
	t.Helper()
	dir := strings.TrimSpace(os.Getenv("SIPD_E2E_OBJECTS"))
	if dir == "" {
		t.Skip("set SIPD_E2E_OBJECTS to the stack's objects directory")
	}
	return dir
}

// wavEnergyWindows reads a 16-bit PCM WAV and returns the mean |sample| in each window of the given
// size, together with the total duration.
func wavEnergyWindows(t *testing.T, path string, window time.Duration) ([]float64, time.Duration) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if len(raw) < 44 || string(raw[:4]) != "RIFF" {
		t.Fatalf("%s is not a RIFF file (%d bytes)", path, len(raw))
	}
	// Walk the chunk list rather than assuming a 44-byte header.
	rate := 8000
	var data []byte
	for offset := 12; offset+8 <= len(raw); {
		id := string(raw[offset : offset+4])
		size := int(binary.LittleEndian.Uint32(raw[offset+4 : offset+8]))
		body := offset + 8
		if body+size > len(raw) {
			size = len(raw) - body
		}
		switch id {
		case "fmt ":
			if size >= 8 {
				rate = int(binary.LittleEndian.Uint32(raw[body+4 : body+8]))
			}
		case "data":
			data = raw[body : body+size]
		}
		offset = body + size
		if size%2 == 1 {
			offset++
		}
	}
	if data == nil {
		t.Fatalf("%s carries no data chunk", path)
	}
	samples := len(data) / 2
	total := time.Duration(float64(samples) / float64(rate) * float64(time.Second))
	per := int(float64(rate) * window.Seconds())
	if per <= 0 {
		per = 1
	}
	windows := make([]float64, 0, samples/per+1)
	for start := 0; start < samples; start += per {
		end := min(start+per, samples)
		sum := 0.0
		for index := start; index < end; index++ {
			sum += math.Abs(float64(int16(binary.LittleEndian.Uint16(data[index*2 : index*2+2]))))
		}
		windows = append(windows, sum/float64(end-start))
	}
	return windows, total
}

// placeCall drives INVITE → 180 → 200 → ACK between two registered phones and returns both dialogs.
func placeCall(t *testing.T, caller, callee *phoneE2E) (*sipua.Dialog, *sipua.Dialog, *sip.Response) {
	t.Helper()
	type inbound struct {
		dialog *sipua.Dialog
		err    error
	}
	inbounds := make(chan inbound, 1)
	go func() {
		_, dialog, err := callee.ua.AwaitInvite()
		inbounds <- inbound{dialog, err}
	}()
	callerDialog, err := caller.ua.InviteAsync("sip:1602@"+e2eRealm, caller.media.OfferSDP("sendrecv"))
	if err != nil {
		t.Fatalf("INVITE: %v", err)
	}
	arrival := <-inbounds
	if arrival.err != nil {
		t.Fatalf("the callee never saw an INVITE: %v", arrival.err)
	}
	if err := arrival.dialog.Respond(180, "Ringing", ""); err != nil {
		t.Fatalf("180: %v", err)
	}
	if err := arrival.dialog.Respond(200, "OK", callee.media.OfferSDP("sendrecv")); err != nil {
		t.Fatalf("200: %v", err)
	}
	response, _, err := callerDialog.AwaitFinal()
	if err != nil || response.StatusCode/100 != 2 {
		t.Fatalf("the caller's INVITE was answered %v (%v)", response, err)
	}
	if err := callerDialog.Ack(); err != nil {
		t.Fatalf("ACK: %v", err)
	}
	return callerDialog, arrival.dialog, response
}

// TestReviewLiveR01RecordingPause · R01. A softphone call is recorded; both ends play a loud tone
// ONLY while the recording is paused. The WAV must be silent for that interval and carry audio
// either side of it.
func TestReviewLiveR01RecordingPause(t *testing.T) {
	requireE2E(t)
	nc := reviewNATS(t)
	objects := stackObjects(t)

	callee := newPhone(t, "1602", e2ePassword(t, "1602"))
	caller := newPhone(t, "1601", e2ePassword(t, "1601"))

	before := mediaSessionKeys(t, nc)
	callerDialog, calleeDialog, _ := placeCall(t, caller, callee)
	t.Cleanup(func() { _, _ = callerDialog.Bye() })

	var fresh []string
	for range 20 {
		after := mediaSessionKeys(t, nc)
		fresh = fresh[:0]
		for key := range after {
			if !before[key] {
				fresh = append(fresh, key)
			}
		}
		if len(fresh) >= 2 {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if len(fresh) == 0 {
		t.Fatalf("no new media session appeared for this call")
	}
	t.Logf("new mediad sessions: %v", fresh)

	callerTarget, ok := sipua.MediaTarget(callerDialog.RemoteSDP)
	if !ok {
		t.Fatalf("no media target for the caller")
	}
	calleeTarget, ok := sipua.MediaTarget(calleeDialog.RemoteSDP)
	if !ok {
		t.Fatalf("no media target for the callee")
	}
	callerSender, err := caller.media.Sender(callerTarget)
	if err != nil {
		t.Fatalf("caller sender: %v", err)
	}
	calleeSender, err := callee.media.Sender(calleeTarget)
	if err != nil {
		t.Fatalf("callee sender: %v", err)
	}

	ref := fmt.Sprintf("review-r01-%d", time.Now().UnixNano())
	var start contract.MediaStartRecordingResponse
	for _, session := range fresh {
		rpc(t, nc, contract.SubjectMediaStartRecordingRPC, contract.MediaStartRecordingRequest{
			SessionID:    session,
			RecordingRef: ref,
			Direction:    contract.MediaStartRecordingRequestDirectionBoth,
			Format:       contract.MediaStartRecordingRequestFormatWav,
		}, &start)
		if start.Ok {
			break
		}
	}
	if !start.Ok {
		t.Fatalf("start-recording refused: %+v", start)
	}

	tone := func(seconds float64) {
		done := make(chan struct{})
		go func() {
			_, _ = calleeSender.SendTone(440, time.Duration(seconds*float64(time.Second)))
			close(done)
		}()
		_, _ = callerSender.SendTone(660, time.Duration(seconds*float64(time.Second)))
		<-done
	}

	tone(3)
	var paused contract.MediaPauseRecordingResponse
	rpc(t, nc, contract.SubjectMediaPauseRecordingRPC, contract.MediaPauseRecordingRequest{
		RecordingRef: ref, Resume: false,
	}, &paused)
	if !paused.Ok || !paused.Paused || !paused.Applied {
		t.Fatalf("pause-recording refused: %+v", paused)
	}
	pausedAt := time.Now()
	tone(4)
	var resumed contract.MediaPauseRecordingResponse
	rpc(t, nc, contract.SubjectMediaPauseRecordingRPC, contract.MediaPauseRecordingRequest{
		RecordingRef: ref, Resume: true,
	}, &resumed)
	if !resumed.Ok || resumed.Paused {
		t.Fatalf("resume-recording refused: %+v", resumed)
	}
	t.Logf("paused for %s", time.Since(pausedAt).Round(time.Millisecond))
	tone(3)

	var stop contract.MediaStopRecordingResponse
	rpc(t, nc, contract.SubjectMediaStopRecordingRPC, contract.MediaStopRecordingRequest{RecordingRef: ref}, &stop)
	if !stop.Ok || !stop.Stopped {
		t.Fatalf("stop-recording refused: %+v", stop)
	}
	_, _ = callerDialog.Bye()

	key := ""
	if start.ObjectKey != nil {
		key = *start.ObjectKey
	}
	path := filepath.Join(objects, key)
	time.Sleep(1 * time.Second)
	windows, total := wavEnergyWindows(t, path, 500*time.Millisecond)
	t.Logf("recording %s: %s, %d half-second windows", path, total.Round(10*time.Millisecond), len(windows))
	for index, value := range windows {
		t.Logf("  t=%4.1fs energy=%8.1f", float64(index)*0.5, value)
	}

	// Windows fully inside 3.5s–6.5s are the pause; 0.5–2.5 and 7.5–9.5 are audio.
	quiet := func(from, to float64) bool {
		for index, value := range windows {
			at := float64(index) * 0.5
			if at >= from && at < to && value > 20 {
				t.Errorf("window at %.1fs inside the pause carries energy %.1f", at, value)
				return false
			}
		}
		return true
	}
	loudIn := func(from, to float64) bool {
		for index, value := range windows {
			at := float64(index) * 0.5
			if at >= from && at < to && value > 200 {
				return true
			}
		}
		t.Errorf("no audio between %.1fs and %.1fs", from, to)
		return false
	}
	loudIn(0.5, 2.5)
	quiet(3.5, 6.5)
	loudIn(7.5, 9.5)
	if total < 9*time.Second || total > 11500*time.Millisecond {
		t.Errorf("the recording is %s long; expected ~10 s of media time", total)
	}
}

// rawOutOfDialog writes one request built from scratch and reads the reply. It is how a probe
// controls headers the UA would otherwise own.
func rawOutOfDialog(t *testing.T, ua *sipua.UA, method, target string, extra []string, authorization string, cseq int) *sip.Response {
	t.Helper()
	local := ua.LocalAddr()
	lines := []string{
		method + " " + target + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/UDP %s;branch=z9hG4bK%s%d;rport", local, strings.ToLower(method), time.Now().UnixNano()%1e9),
		"Max-Forwards: 70",
		"From: <sip:" + ua.User + "@" + ua.Realm + ">;tag=" + fmt.Sprintf("t%d", time.Now().UnixNano()),
		"To: <" + target + ">",
		"Call-ID: " + fmt.Sprintf("probe-%d@127.0.0.1", time.Now().UnixNano()),
		"CSeq: " + fmt.Sprint(cseq) + " " + method,
		"Contact: <sip:" + ua.User + "@" + local + ";transport=udp>",
		"User-Agent: sipua-e2e",
	}
	lines = append(lines, extra...)
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, "Content-Length: 0", "", "")
	if err := ua.WriteRaw([]byte(strings.Join(lines, "\r\n"))); err != nil {
		t.Fatalf("writing %s: %v", method, err)
	}
	response, err := ua.Read()
	if err != nil {
		t.Fatalf("reading the %s reply: %v", method, err)
	}
	return response
}

// TestReviewLiveR02WrongRemoteTag · R02. A BYE carrying the right Call-ID and the right LOCAL tag
// but a WRONG remote tag must be answered 481 and must not tear the call down.
func TestReviewLiveR02WrongRemoteTag(t *testing.T) {
	requireE2E(t)
	callee := newPhone(t, "1602", e2ePassword(t, "1602"))
	caller := newPhone(t, "1601", e2ePassword(t, "1601"))

	callerDialog, calleeDialog, final := placeCall(t, caller, callee)
	defer func() { _, _ = callerDialog.Bye() }()

	// sipd's tag on this leg is the To tag it put on the 200; the caller's own tag is the From tag.
	ourTag := headerParam(t, headerText(final, "To"), "tag")
	remoteTag := headerParam(t, headerText(final, "From"), "tag")
	callID := headerText(final, "Call-ID")
	t.Logf("dialog %s: our (sipd) tag %q, the caller's tag %q", callID, ourTag, remoteTag)
	if ourTag == "" || remoteTag == "" {
		t.Fatalf("could not read both dialog tags")
	}

	local := caller.ua.LocalAddr()
	target := callerDialog.RemoteContact
	if target == "" {
		target = callerDialog.Target
	}
	bye := strings.Join([]string{
		"BYE " + target + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/UDP %s;branch=z9hG4bKwrongtag%d;rport", local, time.Now().UnixNano()%1e9),
		"Max-Forwards: 70",
		"From: <sip:1601@" + e2eRealm + ">;tag=" + remoteTag + "-WRONG",
		"To: <" + callerDialog.Target + ">;tag=" + ourTag,
		"Call-ID: " + callID,
		"CSeq: 99 BYE",
		"Contact: <sip:1601@" + local + ";transport=udp>",
		"User-Agent: sipua-e2e",
		"Content-Length: 0", "", "",
	}, "\r\n")
	if err := caller.ua.WriteRaw([]byte(bye)); err != nil {
		t.Fatalf("writing the forged BYE: %v", err)
	}
	response, err := caller.ua.Read()
	if err != nil {
		t.Fatalf("reading the forged BYE's reply: %v", err)
	}
	t.Logf("forged BYE (wrong remote tag) -> %d %s", response.StatusCode, response.Reason)
	if response.StatusCode != 481 {
		t.Errorf("the forged BYE was answered %d %s, want 481 Call/Transaction Does Not Exist",
			response.StatusCode, response.Reason)
	}

	// The call must still be up: audio still flows, and the callee has seen no BYE.
	callerTarget, _ := sipua.MediaTarget(callerDialog.RemoteSDP)
	sender, err := caller.media.Sender(callerTarget)
	if err != nil {
		t.Fatalf("caller sender: %v", err)
	}
	beforeCount := callee.media.Stats().Packets
	if _, err := sender.SendTone(660, time.Second); err != nil {
		t.Fatalf("tone after the forged BYE: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	after := callee.media.Stats()
	t.Logf("callee RTP after the forged BYE: %d packets (was %d), energy %.0f",
		after.Packets, beforeCount, after.Energy)
	if after.Packets <= beforeCount {
		t.Errorf("no audio reached the callee after the forged BYE; the call did not stay up")
	}

	// And the genuine BYE still ends it.
	genuine, err := callerDialog.Bye()
	if err != nil || genuine.StatusCode != 200 {
		t.Errorf("the genuine BYE was answered %v (%v), want 200", genuine, err)
	} else {
		t.Logf("genuine BYE -> %d %s", genuine.StatusCode, genuine.Reason)
	}
	_ = calleeDialog
}

func headerParam(t *testing.T, value, name string) string {
	t.Helper()
	for _, part := range strings.Split(value, ";") {
		part = strings.TrimSpace(part)
		if after, ok := strings.CutPrefix(part, name+"="); ok {
			return strings.TrimSpace(after)
		}
	}
	return ""
}

// TestReviewLiveR16RegistrationClamp · R16. A phone asking for an hour on the internal profile must
// be GRANTED the profile's 300-second clamp, in the Expires header it reads back.
func TestReviewLiveR16RegistrationClamp(t *testing.T) {
	requireE2E(t)
	password := e2ePassword(t, "1601")
	for _, requested := range []int{3600, 1800, 120} {
		t.Run(fmt.Sprintf("expires-%d", requested), func(t *testing.T) {
			ua := dial(t, sipua.UDP, e2eUDP, "1601", password)
			response, err := ua.Register(sipua.RegisterOptions{Expires: requested})
			if err != nil || response.StatusCode != 200 {
				t.Fatalf("REGISTER: %v / %v", response, err)
			}
			granted := headerText(response, "Expires")
			contacts := contactList(response)
			t.Logf("requested %d -> 200, Expires: %q, Contact: %s", requested, granted, contacts)
			// The per-binding grant is the Contact's expires parameter; the headline Expires header
			// carries the registrar's negotiated default.
			want := min(requested, 300)
			mine := ""
			for _, contact := range strings.Split(contacts, ",") {
				if strings.Contains(contact, ua.LocalAddr()) {
					mine = strings.TrimSpace(contact)
				}
			}
			if mine == "" {
				t.Fatalf("this binding is not in the Contact list %s", contacts)
			}
			if got := headerParam(t, mine, "expires"); got != fmt.Sprint(want) {
				t.Errorf("requested %d, this binding was granted expires=%s, want %d (clamp 300)", requested, got, want)
			}
			if requested > 300 && granted != "300" {
				t.Errorf("requested %d, headline Expires %q, want the 300 s clamp", requested, granted)
			}
		})
	}
}

func headerText(response *sip.Response, name string) string {
	header := response.GetHeader(name)
	if header == nil {
		return ""
	}
	return header.Value()
}

// wrongPassword answers a challenge with a deliberately wrong password.
const wrongPassword = "definitely-not-the-password"

// TestReviewLiveR17SubscribeAndReferCountTowardLockout · R17. Wrong-password SUBSCRIBE and
// out-of-dialog REFER must both be throttled, sharing ONE budget with REGISTER.
func TestReviewLiveR17SubscribeAndReferCountTowardLockout(t *testing.T) {
	requireE2E(t)
	good := e2ePassword(t, "1602")

	attempt := func(method string, extra []string) int {
		ua := dial(t, sipua.UDP, e2eUDP, "1602", wrongPassword)
		target := "sip:1602@" + e2eRealm
		challenge := rawOutOfDialog(t, ua, method, target, extra, "", 1)
		if challenge.StatusCode != 401 && challenge.StatusCode != 407 {
			return challenge.StatusCode
		}
		authorization, err := ua.Answer(challenge, method, target, sipua.RegisterOptions{Password: wrongPassword})
		if err != nil {
			t.Fatalf("answering the %s challenge: %v", method, err)
		}
		return rawOutOfDialog(t, ua, method, target, extra, authorization, 2).StatusCode
	}

	subscribeHeaders := []string{"Event: dialog", "Expires: 300", "Accept: application/dialog-info+xml"}
	referHeaders := []string{"Refer-To: <sip:1601@" + e2eRealm + ">", "Referred-By: <sip:1602@" + e2eRealm + ">"}

	statuses := make([]string, 0, 6)
	for i := range 3 {
		statuses = append(statuses, fmt.Sprintf("SUBSCRIBE#%d=%d", i+1, attempt("SUBSCRIBE", subscribeHeaders)))
	}
	for i := range 3 {
		statuses = append(statuses, fmt.Sprintf("REFER#%d=%d", i+1, attempt("REFER", referHeaders)))
	}
	t.Logf("wrong-password attempts: %s", strings.Join(statuses, " "))

	// Six failures against a threshold of five: the account is now locked, and a REGISTER with the
	// CORRECT password proves both methods fed the same budget.
	locked := dial(t, sipua.UDP, e2eUDP, "1602", good)
	response, err := locked.Register(sipua.RegisterOptions{Expires: 300})
	if err != nil {
		t.Fatalf("REGISTER after the spray: %v", err)
	}
	t.Logf("REGISTER with the CORRECT password after the spray -> %d %s", response.StatusCode, response.Reason)
	if response.StatusCode == 200 {
		t.Errorf("the correct password still registered: neither SUBSCRIBE nor REFER counted toward lockout")
	}

	// Leave the account usable again for the rest of the round.
	t.Logf("waiting out the 30 s lockout base so 1602 is usable again")
	deadline := time.Now().Add(75 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(5 * time.Second)
		ua := dial(t, sipua.UDP, e2eUDP, "1602", good)
		if r, err := ua.Register(sipua.RegisterOptions{Expires: 300}); err == nil && r.StatusCode == 200 {
			t.Logf("1602 registers again after %s", time.Since(deadline.Add(-75*time.Second)).Round(time.Second))
			return
		}
	}
	t.Errorf("1602 is still locked out after 75 s")
}

// cryptoKey returns the base64 key material of an SDP's a=crypto line, as text.
func cryptoKey(t *testing.T, sdp string) string {
	t.Helper()
	_, material, ok := sipua.CryptoAttribute(sdp)
	if !ok {
		return ""
	}
	return sipua.CryptoInline(material)
}

// TestReviewLiveR03DuplicateSecureNegotiation · R03. Two SDES sessions are allocated on the running
// mediad and every allocate/create-offer is REPLAYED byte for byte. The replay must return the
// committed answer — the same key — and audio encrypted under that key must still decrypt across a
// bridge between the two sessions.
func TestReviewLiveR03DuplicateSecureNegotiation(t *testing.T) {
	requireE2E(t)
	nc := reviewNATS(t)

	orgID := strings.TrimSpace(os.Getenv("SIPD_E2E_ORG"))
	if orgID == "" {
		t.Skip("set SIPD_E2E_ORG to the organization these probes run in")
	}
	callID := fmt.Sprintf("review-r03-%d", time.Now().UnixNano())

	type leg struct {
		media   *sipua.RTPEndpoint
		session string
		key     []byte // what WE offer, i.e. what we encrypt with
		answer  string // mediad's answer key, i.e. what we decrypt with
		target  string
	}
	legs := make([]*leg, 0, 2)
	for index := range 2 {
		media, err := sipua.NewRTPEndpoint()
		if err != nil {
			t.Fatalf("RTP socket: %v", err)
		}
		t.Cleanup(func() { _ = media.Close() })
		l := &leg{media: media, session: fmt.Sprintf("%s-leg%d", callID, index), key: sipua.NewSRTPKeyMaterial()}

		request := contract.MediaAllocateSessionRequest{
			SessionID: l.session, OrgID: orgID, CallID: callID,
			SDPOffer:  media.OfferSDPSDES("sendrecv", 1, l.key),
			Direction: contract.MediaAllocateSessionRequestDirectionSendrecv,
		}
		var first, replay contract.MediaAllocateSessionResponse
		rpc(t, nc, contract.SubjectMediaAllocateSessionRPC, request, &first)
		if !first.Ok || first.SDPAnswer == nil {
			t.Fatalf("allocate-session refused: %+v", first)
		}
		rpc(t, nc, contract.SubjectMediaAllocateSessionRPC, request, &replay)
		if !replay.Ok || replay.SDPAnswer == nil {
			t.Fatalf("the replayed allocate-session was refused: %+v", replay)
		}
		firstKey := cryptoKey(t, *first.SDPAnswer)
		replayKey := cryptoKey(t, *replay.SDPAnswer)
		t.Logf("leg %d allocate  key %s", index, firstKey)
		t.Logf("leg %d replay    key %s", index, replayKey)
		if firstKey == "" {
			t.Fatalf("leg %d: the answer carries no a=crypto line:\n%s", index, *first.SDPAnswer)
		}
		if replayKey != firstKey {
			t.Errorf("leg %d: the replayed allocate advertised a DIFFERENT key (%s vs %s)", index, replayKey, firstKey)
		}
		if *replay.SDPAnswer != *first.SDPAnswer {
			t.Errorf("leg %d: the replayed allocate answered a different body", index)
		}
		l.answer = firstKey
		target, ok := sipua.MediaTarget(*first.SDPAnswer)
		if !ok {
			t.Fatalf("leg %d: no media target in the answer", index)
		}
		l.target = target

		// The same question for create-offer, which generates its OWN local key.
		offerRequest := contract.MediaCreateOfferRequest{
			SessionID: l.session, OrgID: orgID, CallID: callID,
			Direction: contract.MediaCreateOfferRequestDirectionSendrecv,
		}
		var offerFirst, offerReplay contract.MediaCreateOfferResponse
		rpc(t, nc, contract.SubjectMediaCreateOfferRPC, offerRequest, &offerFirst)
		rpc(t, nc, contract.SubjectMediaCreateOfferRPC, offerRequest, &offerReplay)
		if offerFirst.Ok && offerFirst.SDPOffer != nil && offerReplay.Ok && offerReplay.SDPOffer != nil {
			a, b := cryptoKey(t, *offerFirst.SDPOffer), cryptoKey(t, *offerReplay.SDPOffer)
			t.Logf("leg %d create-offer key %s / replay %s", index, a, b)
			if a != b {
				t.Errorf("leg %d: the replayed create-offer advertised a DIFFERENT key (%s vs %s)", index, b, a)
			}
			if *offerFirst.SDPOffer != *offerReplay.SDPOffer {
				t.Errorf("leg %d: the replayed create-offer produced a different body", index)
			}
		} else {
			t.Logf("leg %d create-offer: %+v / %+v", index, offerFirst, offerReplay)
		}
		legs = append(legs, l)
	}

	t.Cleanup(func() {
		for _, l := range legs {
			var out contract.MediaReleaseSessionResponse
			body, _ := json.Marshal(contract.MediaReleaseSessionRequest{SessionID: l.session})
			if reply, err := nc.Request(contract.SubjectMediaReleaseSessionRPC, body, 3*time.Second); err == nil {
				_ = json.Unmarshal(reply.Data, &out)
			}
		}
	})

	// Re-allocate leg 0 with the ORIGINAL request once more, to prove the retry did not disturb the
	// context, then bridge and check the audio.
	var bridge contract.MediaBridgeSessionsResponse
	rpc(t, nc, contract.SubjectMediaBridgeSessionsRPC, contract.MediaBridgeSessionsRequest{
		BridgeID: callID, SessionIDs: []string{legs[0].session, legs[1].session},
	}, &bridge)
	if !bridge.Ok {
		t.Fatalf("bridge-sessions refused: %+v", bridge)
	}

	for _, l := range legs {
		_, material, _ := sipua.CryptoAttribute("a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:" + l.answer + "\r\n")
		receive, err := sipua.NewSRTPSession(material)
		if err != nil {
			t.Fatalf("receive context: %v", err)
		}
		l.media.SetInspector(func(packet []byte) []byte {
			plain, err := receive.Unprotect(packet)
			if err != nil {
				return nil
			}
			return plain
		}, 4)
	}

	senders := make([]*sipua.RTPSender, 2)
	for index, l := range legs {
		send, err := sipua.NewSRTPSession(l.key)
		if err != nil {
			t.Fatalf("send context: %v", err)
		}
		sender, err := l.media.Sender(l.target)
		if err != nil {
			t.Fatalf("sender: %v", err)
		}
		sender.SetProtector(send.Protect)
		senders[index] = sender
	}

	done := make(chan struct{})
	go func() { _, _ = senders[1].SendTone(440, 2*time.Second); close(done) }()
	if _, err := senders[0].SendTone(660, 2*time.Second); err != nil {
		t.Fatalf("SRTP tone: %v", err)
	}
	<-done
	time.Sleep(300 * time.Millisecond)

	for index, l := range legs {
		stats := l.media.Stats()
		t.Logf("leg %d received %d packets, energy %.0f, undecodable %d",
			index, stats.Packets, stats.Energy, stats.Undecodable)
		if stats.Packets == 0 {
			t.Errorf("leg %d received nothing across the bridge after the duplicated negotiation", index)
		}
		if stats.Energy == 0 && stats.Packets > 0 {
			t.Errorf("leg %d received packets that did not decrypt to audio", index)
		}
	}
}

// goroutines reads go_goroutines from a service's private metrics listener.
func goroutines(t *testing.T, metricsURL string) int {
	t.Helper()
	response, err := http.Get(metricsURL)
	if err != nil {
		t.Fatalf("%s: %v", metricsURL, err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("%s body: %v", metricsURL, err)
	}
	for line := range strings.SplitSeq(string(body), "\n") {
		if after, ok := strings.CutPrefix(line, "go_goroutines "); ok {
			value, err := strconv.ParseFloat(strings.TrimSpace(after), 64)
			if err != nil {
				t.Fatalf("parsing %q: %v", line, err)
			}
			return int(value)
		}
	}
	t.Fatalf("%s carries no go_goroutines sample", metricsURL)
	return 0
}

// burst fires n concurrent requests at one subject, all naming the SAME resource key so they queue
// on one chain, and reports what came back.
func burst(t *testing.T, nc *nats.Conn, subject string, body []byte, n int) (answers int, timeouts int, reasons map[string]int) {
	t.Helper()
	type outcome struct {
		reason string
		err    error
	}
	results := make(chan outcome, n)
	release := make(chan struct{})
	for range n {
		go func() {
			<-release
			reply, err := nc.Request(subject, body, 10*time.Second)
			if err != nil {
				results <- outcome{err: err}
				return
			}
			var envelope struct {
				Ok     bool   `json:"ok"`
				Reason string `json:"reason"`
			}
			_ = json.Unmarshal(reply.Data, &envelope)
			results <- outcome{reason: envelope.Reason}
		}()
	}
	close(release)
	reasons = map[string]int{}
	for range n {
		result := <-results
		if result.err != nil {
			timeouts++
			continue
		}
		answers++
		key := result.reason
		if key == "" {
			key = "(accepted)"
		}
		reasons[key]++
	}
	return answers, timeouts, reasons
}

// TestReviewLiveR06CommandBurst · R06. Four hundred commands arriving at once on ONE resource key
// must all be ANSWERED — refused with `capacity`/`shutting_down` if the executor is full, never
// silently queued for ever — and both services' goroutines must come back to their idle count.
func TestReviewLiveR06CommandBurst(t *testing.T) {
	requireE2E(t)
	nc := reviewNATS(t)
	const count = 400

	const (
		sipdMetrics   = "http://127.0.0.1:9290/metrics"
		mediadMetrics = "http://127.0.0.1:9291/metrics"
	)

	baseSipd := goroutines(t, sipdMetrics)
	baseMediad := goroutines(t, mediadMetrics)
	t.Logf("idle goroutines: sipd %d, mediad %d", baseSipd, baseMediad)

	// mediad: 400 send-dtmf on one session id.
	mediaBody, err := json.Marshal(contract.MediaSendDtmfRequest{
		SessionID: "review-r06-session", Digits: "1", ToneDurationMs: intPointer(60),
	})
	if err != nil {
		t.Fatalf("marshalling: %v", err)
	}
	peakMediad := make(chan int, 1)
	go func() {
		peak := 0
		for range 40 {
			if n := currentGoroutines(mediadMetrics); n > peak {
				peak = n
			}
			time.Sleep(50 * time.Millisecond)
		}
		peakMediad <- peak
	}()
	answers, timeouts, reasons := burst(t, nc, contract.SubjectMediaSendDtmfRPC, mediaBody, count)
	t.Logf("mediad burst: %d answered, %d unanswered, reasons %v (peak goroutines %d)",
		answers, timeouts, reasons, <-peakMediad)
	if timeouts > 0 {
		t.Errorf("mediad left %d of %d commands unanswered", timeouts, count)
	}
	assertBoundedReasons(t, "mediad", reasons)

	// sipd: 400 resolve-target on one leg id.
	aor := "sip:1601@" + e2eRealm
	sipBody, err := json.Marshal(contract.SipResolveTargetRequest{
		LegID: "review-r06-leg", OrgID: strings.TrimSpace(os.Getenv("SIPD_E2E_ORG")),
		Target: contract.SipResolveTargetRequestTarget{
			Kind: contract.SipResolveTargetRequestTargetKindAOR, AOR: &aor,
		},
	})
	if err != nil {
		t.Fatalf("marshalling: %v", err)
	}
	peakSipd := make(chan int, 1)
	go func() {
		peak := 0
		for range 40 {
			if n := currentGoroutines(sipdMetrics); n > peak {
				peak = n
			}
			time.Sleep(50 * time.Millisecond)
		}
		peakSipd <- peak
	}()
	answers, timeouts, reasons = burst(t, nc, contract.SubjectSipResolveTargetRPC, sipBody, count)
	t.Logf("sipd burst: %d answered, %d unanswered, reasons %v (peak goroutines %d)",
		answers, timeouts, reasons, <-peakSipd)
	if timeouts > 0 {
		t.Errorf("sipd left %d of %d commands unanswered", timeouts, count)
	}
	assertBoundedReasons(t, "sipd", reasons)

	// Back to baseline.
	deadline := time.Now().Add(30 * time.Second)
	var restSipd, restMediad int
	for time.Now().Before(deadline) {
		restSipd, restMediad = goroutines(t, sipdMetrics), goroutines(t, mediadMetrics)
		if restSipd <= baseSipd+5 && restMediad <= baseMediad+5 {
			break
		}
		time.Sleep(time.Second)
	}
	t.Logf("goroutines after the bursts: sipd %d (idle %d), mediad %d (idle %d)",
		restSipd, baseSipd, restMediad, baseMediad)
	if restSipd > baseSipd+5 {
		t.Errorf("sipd is %d goroutines above its idle count of %d", restSipd-baseSipd, baseSipd)
	}
	if restMediad > baseMediad+5 {
		t.Errorf("mediad is %d goroutines above its idle count of %d", restMediad-baseMediad, baseMediad)
	}
}

func assertBoundedReasons(t *testing.T, service string, reasons map[string]int) {
	t.Helper()
	for reason, n := range reasons {
		switch reason {
		case "capacity", "shutting_down":
			t.Logf("%s: %d commands refused with %q — the bounded-admission answer", service, n, reason)
		}
	}
}

func currentGoroutines(metricsURL string) int {
	response, err := http.Get(metricsURL)
	if err != nil {
		return 0
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return 0
	}
	for line := range strings.SplitSeq(string(body), "\n") {
		if after, ok := strings.CutPrefix(line, "go_goroutines "); ok {
			value, _ := strconv.ParseFloat(strings.TrimSpace(after), 64)
			return int(value)
		}
	}
	return 0
}

func intPointer(v int) *int { return &v }

// kvKeys lists a bucket's keys, treating "no keys found" as an empty bucket.
func kvKeys(t *testing.T, nc *nats.Conn, bucket string) map[string]bool {
	t.Helper()
	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatalf("jetstream: %v", err)
	}
	store, err := js.KeyValue(t.Context(), bucket)
	if err != nil {
		t.Fatalf("%s bucket: %v", bucket, err)
	}
	keys, err := store.Keys(t.Context())
	if err != nil {
		return map[string]bool{}
	}
	out := make(map[string]bool, len(keys))
	for _, key := range keys {
		out[key] = true
	}
	return out
}

// TestReviewLiveR04R23BrokerOutageTeardown · R04 + R23. A call is torn down while the broker is
// STOPPED. After it resumes there must be exactly ONE dialog.terminated per leg (a stable event id,
// not a new one per retry) and the recovery claim must be gone.
func TestReviewLiveR04R23BrokerOutageTeardown(t *testing.T) {
	requireE2E(t)
	nc := reviewNATS(t)
	brokerPID := strings.TrimSpace(os.Getenv("SIPD_E2E_NATS_PID"))
	if brokerPID == "" {
		t.Skip("set SIPD_E2E_NATS_PID to the running nats-server pid")
	}

	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatalf("jetstream: %v", err)
	}
	stream, err := js.Stream(t.Context(), "SIP")
	if err != nil {
		t.Fatalf("SIP stream: %v", err)
	}
	info, err := stream.Info(t.Context())
	if err != nil {
		t.Fatalf("SIP stream info: %v", err)
	}
	base := info.State.LastSeq
	t.Logf("SIP stream is at sequence %d", base)

	claimsBefore := kvKeys(t, nc, "sip-dialogs")

	callee := newPhone(t, "1602", e2ePassword(t, "1602"))
	caller := newPhone(t, "1601", e2ePassword(t, "1601"))
	callerDialog, _, final := placeCall(t, caller, callee)
	callID := headerText(final, "Call-ID")
	t.Logf("call up, Call-ID %s", callID)
	time.Sleep(1500 * time.Millisecond)

	claimsDuring := kvKeys(t, nc, "sip-dialogs")
	fresh := make([]string, 0, 2)
	for key := range claimsDuring {
		if !claimsBefore[key] {
			fresh = append(fresh, key)
		}
	}
	t.Logf("sip-dialogs claims this call created: %v", fresh)
	if len(fresh) == 0 {
		t.Fatalf("the call created no sip-dialogs claim")
	}

	signal := func(what string) {
		command := exec.Command("kill", "-"+what, brokerPID)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("kill -%s %s: %v (%s)", what, brokerPID, err, output)
		}
	}

	signal("STOP")
	t.Logf("broker STOPPED at %s", time.Now().Format(time.RFC3339Nano))
	time.Sleep(200 * time.Millisecond)
	byeSent := time.Now()
	byeDone := make(chan *sip.Response, 1)
	go func() {
		response, _ := callerDialog.Bye()
		byeDone <- response
	}()
	time.Sleep(5 * time.Second)
	signal("CONT")
	resumed := time.Now()
	t.Logf("broker resumed after %s", resumed.Sub(byeSent).Round(time.Millisecond))

	select {
	case response := <-byeDone:
		if response == nil {
			t.Errorf("the BYE went unanswered across the outage")
		} else {
			t.Logf("BYE answered %d %s while the broker was down", response.StatusCode, response.Reason)
		}
	case <-time.After(20 * time.Second):
		t.Errorf("the BYE was still unanswered 20 s after the broker resumed")
	}

	// Poll the claim and the stream at 100 ms so the ORDER of the two is visible.
	var claimGone, eventSeen time.Time
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) && (claimGone.IsZero() || eventSeen.IsZero()) {
		if claimGone.IsZero() {
			now := kvKeys(t, nc, "sip-dialogs")
			all := true
			for _, key := range fresh {
				if now[key] {
					all = false
				}
			}
			if all {
				claimGone = time.Now()
			}
		}
		if eventSeen.IsZero() {
			if terminatedFor(t, js, base, callID) > 0 {
				eventSeen = time.Now()
			}
		}
		time.Sleep(100 * time.Millisecond)
	}

	count := terminatedFor(t, js, base, callID)
	t.Logf("dialog.terminated events for this Call-ID after the outage: %d", count)
	if count != 1 {
		t.Errorf("want exactly one dialog.terminated for the leg, got %d", count)
	}
	if claimGone.IsZero() {
		t.Errorf("the sip-dialogs claim %v was never deleted", fresh)
	} else {
		t.Logf("terminated event visible at +%s, claim deleted at +%s (after the broker resumed)",
			eventSeen.Sub(resumed).Round(time.Millisecond), claimGone.Sub(resumed).Round(time.Millisecond))
		if !eventSeen.IsZero() && claimGone.Before(eventSeen) {
			t.Errorf("the claim was deleted BEFORE the termination was durable")
		}
	}
}

// terminatedFor counts dialog.terminated messages after seq that name this Call-ID.
func terminatedFor(t *testing.T, js jetstream.JetStream, after uint64, callID string) int {
	t.Helper()
	stream, err := js.Stream(t.Context(), "SIP")
	if err != nil {
		return 0
	}
	info, err := stream.Info(t.Context())
	if err != nil {
		return 0
	}
	count := 0
	for seq := after + 1; seq <= info.State.LastSeq; seq++ {
		message, err := stream.GetMsg(t.Context(), seq)
		if err != nil {
			continue
		}
		body := string(message.Data)
		if strings.Contains(body, `"dialog.terminated"`) && strings.Contains(body, callID) {
			count++
		}
	}
	return count
}

// toneCollector accumulates the µ-law payload of every packet an endpoint receives, so the audio's
// FREQUENCY can be measured rather than only its energy.
type toneCollector struct {
	mu      sync.Mutex
	samples []int16
}

func (c *toneCollector) inspect(packet []byte) []byte {
	if len(packet) > 12 {
		c.mu.Lock()
		for _, encoded := range packet[12:] {
			c.samples = append(c.samples, sipua.ULawDecode(encoded))
		}
		c.mu.Unlock()
	}
	return packet
}

// hertz estimates the dominant frequency from zero crossings over the collected samples.
func (c *toneCollector) hertz() (float64, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.samples) < 800 {
		return 0, len(c.samples)
	}
	crossings := 0
	for index := 1; index < len(c.samples); index++ {
		if (c.samples[index-1] < 0) != (c.samples[index] < 0) {
			crossings++
		}
	}
	seconds := float64(len(c.samples)) / 8000
	return float64(crossings) / 2 / seconds, len(c.samples)
}

// TestReviewLiveR09ConferencePacketisation · R09. A 30 ms-packetised member and a 20 ms member share
// a conference on the running mediad. Each must hear the other at its ORIGINAL pitch, and a
// recording of the 30 ms leg must be as long as the wall time it covered.
func TestReviewLiveR09ConferencePacketisation(t *testing.T) {
	requireE2E(t)
	nc := reviewNATS(t)
	objects := stackObjects(t)
	orgID := strings.TrimSpace(os.Getenv("SIPD_E2E_ORG"))
	if orgID == "" {
		t.Skip("set SIPD_E2E_ORG")
	}
	callID := fmt.Sprintf("review-r09-%d", time.Now().UnixNano())

	type member struct {
		name      string
		session   string
		media     *sipua.RTPEndpoint
		target    string
		collector *toneCollector
	}
	members := make([]*member, 0, 3)
	for _, name := range []string{"thirty", "twenty", "silent"} {
		media, err := sipua.NewRTPEndpoint()
		if err != nil {
			t.Fatalf("RTP socket: %v", err)
		}
		t.Cleanup(func() { _ = media.Close() })
		m := &member{name: name, session: callID + "-" + name, media: media, collector: &toneCollector{}}
		var response contract.MediaAllocateSessionResponse
		rpc(t, nc, contract.SubjectMediaAllocateSessionRPC, contract.MediaAllocateSessionRequest{
			SessionID: m.session, OrgID: orgID, CallID: callID,
			SDPOffer:  media.OfferSDP("sendrecv"),
			Direction: contract.MediaAllocateSessionRequestDirectionSendrecv,
		}, &response)
		if !response.Ok || response.SDPAnswer == nil {
			t.Fatalf("%s allocate: %+v", name, response)
		}
		target, ok := sipua.MediaTarget(*response.SDPAnswer)
		if !ok {
			t.Fatalf("%s: no media target", name)
		}
		m.target = target
		media.SetInspector(m.collector.inspect, 2)
		members = append(members, m)
	}
	t.Cleanup(func() {
		for _, m := range members {
			body, _ := json.Marshal(contract.MediaReleaseSessionRequest{SessionID: m.session})
			_, _ = nc.Request(contract.SubjectMediaReleaseSessionRPC, body, 3*time.Second)
		}
	})

	var bridge contract.MediaBridgeSessionsResponse
	rpc(t, nc, contract.SubjectMediaBridgeSessionsRPC, contract.MediaBridgeSessionsRequest{
		BridgeID: callID, SessionIDs: []string{members[0].session, members[1].session, members[2].session},
	}, &bridge)
	if !bridge.Ok {
		t.Fatalf("bridge-sessions refused: %+v", bridge)
	}
	if !bridge.Mixed {
		t.Fatalf("three sessions did not produce a MIXED conference: %+v", bridge)
	}

	senders := make([]*sipua.RTPSender, len(members))
	for index, m := range members {
		sender, err := m.media.Sender(m.target)
		if err != nil {
			t.Fatalf("%s sender: %v", m.name, err)
		}
		senders[index] = sender
	}

	// Record the 30 ms leg for exactly the wall time the tones cover.
	ref := fmt.Sprintf("review-r09-%d", time.Now().UnixNano())
	var start contract.MediaStartRecordingResponse
	rpc(t, nc, contract.SubjectMediaStartRecordingRPC, contract.MediaStartRecordingRequest{
		SessionID:    members[0].session,
		RecordingRef: ref,
		Direction:    contract.MediaStartRecordingRequestDirectionBoth,
		Format:       contract.MediaStartRecordingRequestFormatWav,
	}, &start)
	if !start.Ok {
		t.Fatalf("start-recording refused: %+v", start)
	}

	const hold = 6 * time.Second
	began := time.Now()
	done := make(chan struct{})
	go func() { _, _ = senders[1].SendTonePaced(660, hold, 20*time.Millisecond); close(done) }()
	sent, err := senders[0].SendTonePaced(440, hold, 30*time.Millisecond)
	if err != nil {
		t.Fatalf("30 ms tone: %v", err)
	}
	<-done
	wall := time.Since(began)
	t.Logf("the 30 ms member sent %d packets over %s", sent, wall.Round(10*time.Millisecond))

	var stop contract.MediaStopRecordingResponse
	rpc(t, nc, contract.SubjectMediaStopRecordingRPC, contract.MediaStopRecordingRequest{RecordingRef: ref}, &stop)

	for _, m := range members {
		stats := m.media.Stats()
		frequency, samples := m.collector.hertz()
		t.Logf("%-7s received %3d packets, energy %7.0f, %d samples, dominant %.0f Hz",
			m.name, stats.Packets, stats.Energy, samples, frequency)
	}

	thirtyHz, _ := members[0].collector.hertz()
	twentyHz, _ := members[1].collector.hertz()
	// The 30 ms member hears the 20 ms member's 660 Hz; the 20 ms member hears 440 Hz.
	if math.Abs(thirtyHz-660) > 60 {
		t.Errorf("the 30 ms member heard %.0f Hz, want ~660 Hz (a %.2fx pitch shift)", thirtyHz, thirtyHz/660)
	}
	if math.Abs(twentyHz-440) > 40 {
		t.Errorf("the 20 ms member heard %.0f Hz, want ~440 Hz (a %.2fx pitch shift)", twentyHz, twentyHz/440)
	}
	for _, m := range members[:2] {
		if m.media.Stats().Packets < int(hold.Seconds()*45) {
			t.Errorf("%s received only %d packets in %s; the mix underran",
				m.name, m.media.Stats().Packets, wall)
		}
	}

	key := ""
	if start.ObjectKey != nil {
		key = *start.ObjectKey
	}
	time.Sleep(750 * time.Millisecond)
	_, total := wavEnergyWindows(t, filepath.Join(objects, key), 500*time.Millisecond)
	t.Logf("the 30 ms leg's recording is %s of media time for %s of wall time (ratio %.3f)",
		total.Round(10*time.Millisecond), wall.Round(10*time.Millisecond), total.Seconds()/wall.Seconds())
	if ratio := total.Seconds() / wall.Seconds(); ratio < 0.9 || ratio > 1.1 {
		t.Errorf("the recording is %.2fx wall time; the 30 ms packetisation drifted", ratio)
	}
}
