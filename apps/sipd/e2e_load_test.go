//go:build e2e

// Concurrent-call and registration-churn load against a RUNNING stack (see .scripts/local-stack).
// Nothing here starts a server: the point is the real sipd, engine, mediad and api under N calls at
// once, so a capacity claim about the deployment is reproducible.
//
//	SIPD_E2E=1 SIPD_E2E_ROSTER=/path/roster.json SIPD_E2E_STORM_PAIRS=100 \
//	  go test -count=1 -tags e2e -run TestE2ECallStorm -v -timeout 30m .
//
// The roster is `[{"number":"5000","password":"…"}, …]` — derived SIP passwords, produced outside
// this module because the derivation key belongs to the api deployment.
package sipd_test

import (
	"cmp"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// rosterEntry is one provisioned extension the storm may use as a leg.
type rosterEntry struct {
	Number   string `json:"number"`
	Password string `json:"password"`
}

func loadRoster(t *testing.T) []rosterEntry {
	t.Helper()
	path := strings.TrimSpace(os.Getenv("SIPD_E2E_ROSTER"))
	if path == "" {
		t.Skip("set SIPD_E2E_ROSTER to a JSON roster of {number,password} extensions")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the roster: %v", err)
	}
	var roster []rosterEntry
	if err := json.Unmarshal(raw, &roster); err != nil {
		t.Fatalf("parsing the roster: %v", err)
	}
	if len(roster) < 2 {
		t.Fatalf("the roster has %d entries; a call needs two", len(roster))
	}
	return roster
}

func e2eInt(name string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

// percentile returns the p'th percentile of samples, which it sorts in place.
func percentile(samples []time.Duration, p float64) time.Duration {
	if len(samples) == 0 {
		return 0
	}
	slices.Sort(samples)
	index := int(math.Ceil(p/100*float64(len(samples)))) - 1
	return samples[min(max(index, 0), len(samples)-1)]
}

// legOutcome is what one call in the storm reported back.
type legOutcome struct {
	setupToRing  time.Duration
	ringToAudio  time.Duration
	teardown     time.Duration
	callerPacket int
	calleePacket int
	callerLost   int
	calleeLost   int
	err          error
}

// runOneCall drives a single INVITE → 180 → 200 → paced G.711 → BYE between two registered phones
// and reports the three latencies plus what each side received.
//
// Every failure is returned rather than fataled: a storm is judged by how many legs failed, and
// t.Fatalf from a worker goroutine would stop the run at the first one.
func runOneCall(caller, callee *phoneE2E, calleeNumber string, hold time.Duration) legOutcome {
	var outcome legOutcome

	type inbound struct {
		dialog *sipua.Dialog
		err    error
	}
	inbounds := make(chan inbound, 1)
	go func() {
		_, dialog, err := callee.ua.AwaitInvite()
		inbounds <- inbound{dialog, err}
	}()

	started := time.Now()
	callerDialog, err := caller.ua.InviteAsync("sip:"+calleeNumber+"@"+e2eRealm, caller.media.OfferSDP("sendrecv"))
	if err != nil {
		outcome.err = fmt.Errorf("INVITE: %w", err)
		return outcome
	}
	arrival := <-inbounds
	if arrival.err != nil {
		outcome.err = fmt.Errorf("the INVITE never reached %s: %w", calleeNumber, arrival.err)
		return outcome
	}
	calleeDialog := arrival.dialog
	if err := calleeDialog.Respond(180, "Ringing", ""); err != nil {
		outcome.err = fmt.Errorf("180: %w", err)
		return outcome
	}
	rang := time.Now()
	outcome.setupToRing = rang.Sub(started)

	if err := calleeDialog.Respond(200, "OK", callee.media.OfferSDP("sendrecv")); err != nil {
		outcome.err = fmt.Errorf("200: %w", err)
		return outcome
	}
	final, _, err := callerDialog.AwaitFinal()
	if err != nil || final.StatusCode/100 != 2 {
		outcome.err = fmt.Errorf("the caller's INVITE ended %v (%w)", final, err)
		return outcome
	}
	if err := callerDialog.Ack(); err != nil {
		outcome.err = fmt.Errorf("ACK: %w", err)
		return outcome
	}

	callerTarget, ok := sipua.MediaTarget(callerDialog.RemoteSDP)
	if !ok {
		outcome.err = fmt.Errorf("the caller got no media target from %q", callerDialog.RemoteSDP)
		return outcome
	}
	calleeTarget, ok := sipua.MediaTarget(calleeDialog.RemoteSDP)
	if !ok {
		outcome.err = fmt.Errorf("the callee got no media target from %q", calleeDialog.RemoteSDP)
		return outcome
	}
	callerSender, err := caller.media.Sender(callerTarget)
	if err != nil {
		outcome.err = fmt.Errorf("caller sender: %w", err)
		return outcome
	}
	calleeSender, err := callee.media.Sender(calleeTarget)
	if err != nil {
		outcome.err = fmt.Errorf("callee sender: %w", err)
		return outcome
	}

	stop := make(chan struct{})
	var senders sync.WaitGroup
	send := func(sender *sipua.RTPSender, frequency float64) {
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := sender.SendTone(frequency, 200*time.Millisecond); err != nil {
				return
			}
		}
	}
	senders.Go(func() { send(callerSender, 660) })
	senders.Go(func() { send(calleeSender, 440) })

	// ring-to-audio is measured at the CALLER, on the first packet that actually traversed mediad.
	deadline := time.Now().Add(10 * time.Second)
	for caller.media.Stats().Packets == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	outcome.ringToAudio = time.Since(rang)

	time.Sleep(hold)
	close(stop)
	senders.Wait()

	byeSent := time.Now()
	if bye, err := callerDialog.Bye(); err != nil {
		outcome.err = fmt.Errorf("BYE: %w", err)
	} else if bye.StatusCode != 200 {
		outcome.err = fmt.Errorf("BYE -> %d %s", bye.StatusCode, bye.Reason)
	}
	outcome.teardown = time.Since(byeSent)

	callerStats := caller.media.Stats()
	calleeStats := callee.media.Stats()
	outcome.callerPacket, outcome.callerLost = callerStats.Packets, callerStats.Lost
	outcome.calleePacket, outcome.calleeLost = calleeStats.Packets, calleeStats.Lost
	return outcome
}

// report prints the storm's latency distribution and RTP accounting in one block, so a run's
// numbers can be lifted into a table without arithmetic.
func report(t *testing.T, label string, outcomes []legOutcome, wall time.Duration) {
	t.Helper()
	setup := make([]time.Duration, 0, len(outcomes))
	audio := make([]time.Duration, 0, len(outcomes))
	teardown := make([]time.Duration, 0, len(outcomes))
	packets, lost, failures := 0, 0, 0
	for _, outcome := range outcomes {
		if outcome.err != nil {
			failures++
			continue
		}
		setup = append(setup, outcome.setupToRing)
		audio = append(audio, outcome.ringToAudio)
		teardown = append(teardown, outcome.teardown)
		packets += outcome.callerPacket + outcome.calleePacket
		lost += outcome.callerLost + outcome.calleeLost
	}
	round := func(d time.Duration) string { return d.Round(time.Microsecond).String() }
	t.Logf("%s: %d calls, %d failed, wall %s", label, len(outcomes), failures, wall.Round(time.Millisecond))
	t.Logf("%s: setup-to-ring p50 %s p99 %s | ring-to-audio p50 %s p99 %s | teardown p50 %s p99 %s",
		label,
		round(percentile(setup, 50)), round(percentile(setup, 99)),
		round(percentile(audio, 50)), round(percentile(audio, 99)),
		round(percentile(teardown, 50)), round(percentile(teardown, 99)))
	t.Logf("%s: RTP received %d packets, lost %d (%.4f%%)", label, packets, lost,
		100*float64(lost)/float64(max(packets+lost, 1)))
	for _, outcome := range outcomes {
		if outcome.err != nil {
			t.Logf("%s: leg failed: %v", label, outcome.err)
		}
	}
}

// registerAll brings up 2*pairs phones from the roster and reports how long the registration burst
// took. A phone that will not register is fatal: the storm's numbers are meaningless without it.
func registerAll(t *testing.T, roster []rosterEntry, count int) []*phoneE2E {
	t.Helper()
	if count > len(roster) {
		t.Fatalf("the storm needs %d extensions; the roster has %d", count, len(roster))
	}
	phones := make([]*phoneE2E, count)
	var failures atomic.Int64
	var group sync.WaitGroup
	// The burst width is a knob because it is itself a finding: a 200-wide REGISTER burst grazes the
	// credential RPC's 500 ms contract deadline, so a storm that wants to measure CALLS rather than
	// registration has to widen the ramp.
	gate := make(chan struct{}, e2eInt("SIPD_E2E_REG_CONCURRENCY", count))
	started := time.Now()
	for index := range count {
		group.Go(func() {
			gate <- struct{}{}
			defer func() { <-gate }()
			ua, err := sipua.Dial(sipua.Options{
				Transport: sipua.UDP, Remote: e2eUDP, Realm: e2eRealm,
				User: roster[index].Number, Password: roster[index].Password, Timeout: 20 * time.Second,
			})
			if err != nil {
				failures.Add(1)
				t.Logf("%s dial: %v", roster[index].Number, err)
				return
			}
			response, err := ua.Register(sipua.RegisterOptions{Expires: 300})
			if err != nil || response.StatusCode != 200 {
				failures.Add(1)
				t.Logf("%s REGISTER: %v / %v", roster[index].Number, response, err)
				_ = ua.Close()
				return
			}
			media, err := sipua.NewRTPEndpoint()
			if err != nil {
				failures.Add(1)
				t.Logf("%s RTP socket: %v", roster[index].Number, err)
				_ = ua.Close()
				return
			}
			phones[index] = &phoneE2E{ua: ua, media: media}
		})
	}
	group.Wait()
	t.Logf("registered %d/%d phones in %s", count-int(failures.Load()), count, time.Since(started).Round(time.Millisecond))
	t.Cleanup(func() {
		for _, phone := range phones {
			if phone != nil {
				_ = phone.media.Close()
				_ = phone.ua.Close()
			}
		}
	})
	if failures.Load() > 0 {
		t.Fatalf("%d phones did not come up", failures.Load())
	}
	return phones
}

// TestE2ECallStorm runs SIPD_E2E_STORM_PAIRS concurrent two-party calls through real routing, each
// holding SIPD_E2E_STORM_SECONDS of paced G.711.
func TestE2ECallStorm(t *testing.T) {
	requireE2E(t)
	roster := loadRoster(t)
	pairs := e2eInt("SIPD_E2E_STORM_PAIRS", 100)
	hold := time.Duration(e2eInt("SIPD_E2E_STORM_SECONDS", 20)) * time.Second
	label := cmp.Or(strings.TrimSpace(os.Getenv("SIPD_E2E_STORM_LABEL")), fmt.Sprintf("storm-%d", pairs))

	phones := registerAll(t, roster, pairs*2)
	// A settling pause: the registrar's KV writes and the engine's routing lookups should not be
	// racing the first INVITE, or the storm measures registration rather than call setup.
	time.Sleep(2 * time.Second)

	outcomes := make([]legOutcome, pairs)
	var group sync.WaitGroup
	started := time.Now()
	for index := range pairs {
		group.Go(func() {
			outcomes[index] = runOneCall(phones[index*2], phones[index*2+1], roster[index*2+1].Number, hold)
		})
	}
	group.Wait()
	report(t, label, outcomes, time.Since(started))
}

// TestE2ERegistrationChurn re-registers SIPD_E2E_CHURN_PHONES extensions on a 60 s expiry while
// SIPD_E2E_CHURN_PAIRS calls run back to back, for SIPD_E2E_CHURN_MINUTES.
func TestE2ERegistrationChurn(t *testing.T) {
	requireE2E(t)
	roster := loadRoster(t)
	phoneCount := e2eInt("SIPD_E2E_CHURN_PHONES", 1000)
	pairs := e2eInt("SIPD_E2E_CHURN_PAIRS", 50)
	minutes := e2eInt("SIPD_E2E_CHURN_MINUTES", 5)
	hold := time.Duration(e2eInt("SIPD_E2E_STORM_SECONDS", 20)) * time.Second

	callPhones := registerAll(t, roster, pairs*2)

	// The churn set registers on a 60 s expiry and refreshes at half of it, which is what a real
	// fleet does; it is disjoint from the calling set so a re-REGISTER never races a live dialog.
	churn := make([]*sipua.UA, 0, phoneCount)
	var churnFailures atomic.Int64
	var churnGroup sync.WaitGroup
	var churnMu sync.Mutex
	churnGate := make(chan struct{}, e2eInt("SIPD_E2E_REG_CONCURRENCY", phoneCount))
	churnStarted := time.Now()
	for index := pairs * 2; index < min(pairs*2+phoneCount, len(roster)); index++ {
		churnGroup.Go(func() {
			churnGate <- struct{}{}
			defer func() { <-churnGate }()
			ua, err := sipua.Dial(sipua.Options{
				Transport: sipua.UDP, Remote: e2eUDP, Realm: e2eRealm,
				User: roster[index].Number, Password: roster[index].Password, Timeout: 20 * time.Second,
			})
			if err != nil {
				churnFailures.Add(1)
				return
			}
			response, err := ua.Register(sipua.RegisterOptions{Expires: 60})
			if err != nil || response.StatusCode != 200 {
				churnFailures.Add(1)
				_ = ua.Close()
				return
			}
			churnMu.Lock()
			churn = append(churn, ua)
			churnMu.Unlock()
		})
	}
	churnGroup.Wait()
	t.Logf("churn set: %d registered, %d failed, in %s", len(churn), churnFailures.Load(),
		time.Since(churnStarted).Round(time.Millisecond))
	t.Cleanup(func() {
		for _, ua := range churn {
			_ = ua.Close()
		}
	})

	deadline := time.Now().Add(time.Duration(minutes) * time.Minute)
	stop := make(chan struct{})
	var refreshes, refreshFailures atomic.Int64
	var refreshers sync.WaitGroup
	for _, ua := range churn {
		refreshers.Go(func() {
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-stop:
					return
				case <-ticker.C:
					response, err := ua.Register(sipua.RegisterOptions{Expires: 60})
					if err != nil || response.StatusCode != 200 {
						refreshFailures.Add(1)
						continue
					}
					refreshes.Add(1)
				}
			}
		})
	}

	var outcomes []legOutcome
	var outcomeMu sync.Mutex
	rounds := 0
	for time.Now().Before(deadline) {
		batch := make([]legOutcome, pairs)
		var group sync.WaitGroup
		for index := range pairs {
			group.Go(func() {
				batch[index] = runOneCall(callPhones[index*2], callPhones[index*2+1], roster[index*2+1].Number, hold)
			})
		}
		group.Wait()
		outcomeMu.Lock()
		outcomes = append(outcomes, batch...)
		outcomeMu.Unlock()
		rounds++
	}
	close(stop)
	refreshers.Wait()

	t.Logf("churn: %d refreshes, %d failed, over %d call rounds", refreshes.Load(), refreshFailures.Load(), rounds)
	report(t, "churn", outcomes, time.Duration(minutes)*time.Minute)
}

// TestE2ECredentialRPCBurst measures the api's `rpc.sip.v1.credential` responder against a burst of
// distinct accounts, which is what a fleet-wide re-registration looks like at the edge.
//
// It exists because the registration burst in TestE2ECallStorm hit the 500 ms contract timeout: the
// number that decides whether that is sipd's fault or the responder's is this one.
func TestE2ECredentialRPCBurst(t *testing.T) {
	requireE2E(t)
	roster := loadRoster(t)
	url := cmp.Or(strings.TrimSpace(os.Getenv("SIPD_E2E_NATS_URL")), "nats://127.0.0.1:4322")
	user := strings.TrimSpace(os.Getenv("SIPD_E2E_NATS_USER"))
	password := strings.TrimSpace(os.Getenv("SIPD_E2E_NATS_PASS"))
	if user == "" || password == "" {
		t.Skip("set SIPD_E2E_NATS_USER and SIPD_E2E_NATS_PASS to probe the credential responder")
	}
	burst := e2eInt("SIPD_E2E_RPC_BURST", 200)

	// The `sipd` broker user may only subscribe to `_INBOX.sipd.>`, so a default-prefix reply
	// inbox is refused and every request times out — a healthy responder reads as 100 % failure.
	conn, err := nats.Connect(url,
		nats.UserInfo(user, password),
		nats.CustomInboxPrefix("_INBOX.sipd"),
		nats.Name("sipd-e2e-rpc-burst"))
	if err != nil {
		t.Fatalf("connecting to the broker: %v", err)
	}
	defer conn.Close()

	latencies := make([]time.Duration, burst)
	errs := make([]error, burst)
	var group sync.WaitGroup
	started := time.Now()
	for index := range burst {
		group.Go(func() {
			payload, err := json.Marshal(contract.SipCredentialRequest{
				Realm: e2eRealm, Username: roster[index%len(roster)].Number,
			})
			if err != nil {
				errs[index] = err
				return
			}
			at := time.Now()
			_, err = conn.Request(contract.SubjectSipCredentialRPC, payload, 5*time.Second)
			latencies[index] = time.Since(at)
			errs[index] = err
		})
	}
	group.Wait()
	wall := time.Since(started)

	failed, overContract := 0, 0
	for index, err := range errs {
		if err != nil {
			failed++
			continue
		}
		if latencies[index] > contract.TimeoutSipCredentialRPC {
			overContract++
		}
	}
	t.Logf("credential RPC burst %d: %d failed, %d over the %s contract timeout, wall %s",
		burst, failed, overContract, contract.TimeoutSipCredentialRPC, wall.Round(time.Millisecond))
	t.Logf("credential RPC burst %d: p50 %s p90 %s p99 %s max %s", burst,
		percentile(latencies, 50).Round(time.Millisecond),
		percentile(latencies, 90).Round(time.Millisecond),
		percentile(latencies, 99).Round(time.Millisecond),
		percentile(latencies, 100).Round(time.Millisecond))
}
