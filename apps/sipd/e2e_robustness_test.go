//go:build e2e

package sipd_test

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"
)

const e2eHealth = "http://127.0.0.1:9290"

// pprofCounts reads the goroutine and heap totals off the live pprof listener, which is the only
// leak signal available without restarting the process.
func pprofCounts(t *testing.T) (goroutines int, heapObjects int) {
	t.Helper()
	response, err := http.Get(e2eHealth + "/debug/pprof/goroutine?debug=1")
	if err != nil {
		t.Fatalf("reading the goroutine profile: %v", err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if after, found := strings.CutPrefix(line, "goroutine profile: total "); found {
			goroutines, _ = strconv.Atoi(strings.TrimSpace(after))
			break
		}
	}

	heapResponse, err := http.Get(e2eHealth + "/debug/pprof/heap?debug=1")
	if err != nil {
		t.Fatalf("reading the heap profile: %v", err)
	}
	defer heapResponse.Body.Close()
	body, _ := io.ReadAll(heapResponse.Body)
	for line := range strings.SplitSeq(string(body), "\n") {
		if after, found := strings.CutPrefix(strings.TrimSpace(line), "# HeapObjects = "); found {
			heapObjects, _ = strconv.Atoi(strings.TrimSpace(after))
			break
		}
	}
	return goroutines, heapObjects
}

// malformed is the light fuzz corpus: each entry must be answered or dropped, and none may take the
// edge down.
func malformedMessages() map[string][]byte {
	huge := strings.Repeat("a", 9000)
	return map[string][]byte{
		"truncated-headers":    []byte("REGISTER sip:local.test SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1"),
		"no-body-terminator":   []byte("REGISTER sip:local.test SIP/2.0\r\nCSeq: 1 REGISTER\r\n"),
		"huge-via":             []byte("REGISTER sip:local.test SIP/2.0\r\nVia: SIP/2.0/UDP " + huge + ";branch=z9hG4bKx\r\nCSeq: 1 REGISTER\r\nContent-Length: 0\r\n\r\n"),
		"negative-length":      []byte("REGISTER sip:local.test SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1;branch=z9hG4bKx\r\nCSeq: 1 REGISTER\r\nContent-Length: -5\r\n\r\n"),
		"overstated-length":    []byte("REGISTER sip:local.test SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1;branch=z9hG4bKx\r\nCSeq: 1 REGISTER\r\nContent-Length: 100000\r\n\r\nshort"),
		"bad-start-line":       []byte("NOTAMETHOD\r\n\r\n"),
		"binary":               {0x00, 0xff, 0xfe, 0x01, 0x02, 0x03},
		"empty":                {},
		"crlf-injection":       []byte("REGISTER sip:local.test SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1;branch=z9hG4bKx\r\nFrom: <sip:a@local.test>\r\nInjected: x\r\nX-Evil: y\r\nCSeq: 1 REGISTER\r\nContent-Length: 0\r\n\r\n"),
		"absurd-cseq":          []byte("REGISTER sip:local.test SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1;branch=z9hG4bKx\r\nCSeq: 99999999999999999999 REGISTER\r\nContent-Length: 0\r\n\r\n"),
		"contact-no-host":      []byte("REGISTER sip:local.test SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1;branch=z9hG4bKx\r\nFrom: <sip:1601@local.test>;tag=a\r\nTo: <sip:1601@local.test>\r\nCall-ID: fuzz\r\nCSeq: 1 REGISTER\r\nContact: <sip:>\r\nContent-Length: 0\r\n\r\n"),
		"expires-not-a-number": []byte("REGISTER sip:local.test SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1;branch=z9hG4bKx\r\nFrom: <sip:1601@local.test>;tag=a\r\nTo: <sip:1601@local.test>\r\nCall-ID: fuzz2\r\nCSeq: 1 REGISTER\r\nContact: <sip:1601@127.0.0.1:5555>\r\nExpires: soon\r\nContent-Length: 0\r\n\r\n"),
	}
}

// TestE2EMalformedSIP sprays malformed messages at every transport and checks the edge is still
// registering afterwards, with no goroutine or heap growth attributable to the spray.
func TestE2EMalformedSIP(t *testing.T) {
	requireE2E(t)
	password := e2ePassword(t, "1601")

	goroutinesBefore, heapBefore := pprofCounts(t)
	t.Logf("before: goroutines=%d heapObjects=%d", goroutinesBefore, heapBefore)

	const rounds = 20
	for _, transport := range []sipua.Transport{sipua.UDP, sipua.TCP, sipua.TLS} {
		remote := e2eUDP
		if transport == sipua.TLS {
			remote = e2eTLS
		}
		t.Run(string(transport), func(t *testing.T) {
			for round := range rounds {
				for name, payload := range malformedMessages() {
					ua, err := sipua.Dial(sipua.Options{
						Transport: transport, Remote: remote, Realm: e2eRealm,
						User: "1601", Password: password, Timeout: 300 * time.Millisecond,
					})
					if err != nil {
						t.Fatalf("round %d, %s: dialing: %v", round, name, err)
					}
					if err := ua.WriteRaw(payload); err != nil && round == 0 {
						t.Logf("%s/%s: write: %v", transport, name, err)
					}
					// A refusal, a drop or a closed connection are all acceptable; a crash is not.
					if response, err := ua.Read(); err == nil && round == 0 {
						t.Logf("%s/%s -> %d %s", transport, name, response.StatusCode, response.Reason)
					}
					_ = ua.Close()
				}
			}
		})
	}

	// The edge must still be healthy and still register a real phone.
	response, err := http.Get(e2eHealth + "/healthz")
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("healthz after the spray: %v / %v", response, err)
	}
	_ = response.Body.Close()

	ua := dial(t, sipua.UDP, e2eUDP, "1601", password)
	final, err := ua.Register(sipua.RegisterOptions{Expires: 300})
	if err != nil || final.StatusCode != 200 {
		t.Fatalf("REGISTER after the spray: %v / %v", final, err)
	}

	time.Sleep(2 * time.Second)
	goroutinesAfter, heapAfter := pprofCounts(t)
	t.Logf("after: goroutines=%d heapObjects=%d (delta %+d goroutines, %+d heap objects) over %d messages",
		goroutinesAfter, heapAfter, goroutinesAfter-goroutinesBefore, heapAfter-heapBefore,
		rounds*len(malformedMessages())*3)
	if goroutinesAfter > goroutinesBefore+50 {
		t.Errorf("goroutines grew from %d to %d across the malformed spray", goroutinesBefore, goroutinesAfter)
	}
}

// TestE2ERegistrationLimit binds more devices than max_registrations allows and reports what the
// edge does with the surplus.
func TestE2ERegistrationLimit(t *testing.T) {
	requireE2E(t)
	password := e2ePassword(t, "1602")

	uas := make([]*sipua.UA, 0, 5)
	for index := range 5 {
		ua := dial(t, sipua.UDP, e2eUDP, "1602", password)
		ua.SetCallID(fmt.Sprintf("sipua-limit-%d-%d", time.Now().UnixNano(), index))
		response, err := ua.Register(sipua.RegisterOptions{Expires: 300})
		if err != nil {
			t.Fatalf("device %d REGISTER: %v", index, err)
		}
		t.Logf("device %d -> %d %s; bindings now: %s", index, response.StatusCode, response.Reason, contactList(response))
		uas = append(uas, ua)
	}
	final, err := uas[len(uas)-1].Register(sipua.RegisterOptions{Expires: 300})
	if err != nil {
		t.Fatalf("final REGISTER: %v", err)
	}
	listed := strings.Count(contactList(final), "sip:1602@")
	t.Logf("after five devices the AOR holds %d bindings (max_registrations is 3)", listed)
	if listed > 3 {
		t.Errorf("the edge kept %d bindings for an extension limited to 3", listed)
	}
}
