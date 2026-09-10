package metrics

import (
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/emiago/sipgo/sip"
)

func TestWrapCountsRegisterOutcomes(t *testing.T) {
	m := New()
	respondWith := func(codes ...int) {
		handler := m.Wrap("REGISTER", func(_ *sip.Request, tx sip.ServerTransaction) {
			for _, code := range codes {
				_ = tx.Respond(&sip.Response{StatusCode: code})
			}
		})
		handler(&sip.Request{}, &fakeTransaction{})
	}
	respondWith(200)
	respondWith(401)
	respondWith(403)
	// Provisional first, then the final: only the final counts, and only the first of those.
	respondWith(100, 200, 500)

	body := scrape(t, m)
	for _, want := range []string{
		`sipd_registrations_total{outcome="accepted"} 2`,
		`sipd_registrations_total{outcome="challenged"} 1`,
		`sipd_registrations_total{outcome="refused"} 1`,
		`sipd_auth_failures_total{method="REGISTER"} 1`,
		`sipd_sip_requests_total{method="REGISTER"} 4`,
		`sipd_sip_responses_total{method="REGISTER",status="200"} 2`,
		`sipd_sip_responses_total{method="REGISTER",status="401"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("scrape is missing %q", want)
		}
	}
	if strings.Contains(body, `status="100"`) {
		t.Error("a provisional response was counted as final")
	}
	if strings.Contains(body, `status="500"`) {
		t.Error("a second final response overwrote the first")
	}
}

// A handler that answers nothing must still be visible, or the request and response totals drift
// apart with nothing saying where.
func TestWrapCountsAnAbsorbedTransaction(t *testing.T) {
	m := New()
	m.Wrap("ACK", func(*sip.Request, sip.ServerTransaction) {})(&sip.Request{}, &fakeTransaction{})
	if body := scrape(t, m); !strings.Contains(body, `sipd_sip_responses_total{method="ACK",status="none"} 1`) {
		t.Error("an absorbed transaction was not counted")
	}
}

// The INVITE and REFER handlers respond from another goroutine, so the observer is written on one
// goroutine and read on the wrapper's. Run under -race, where this is the whole point of the test.
func TestWrapIsSafeWhenTheHandlerRespondsAsynchronously(t *testing.T) {
	m := New()
	var wg sync.WaitGroup
	handler := m.Wrap("INVITE", func(_ *sip.Request, tx sip.ServerTransaction) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = tx.Respond(&sip.Response{StatusCode: 200})
		}()
	})
	for range 32 {
		handler(&sip.Request{}, &fakeTransaction{})
	}
	wg.Wait()
	if body := scrape(t, m); !strings.Contains(body, `sipd_sip_requests_total{method="INVITE"} 32`) {
		t.Error("asynchronous INVITEs were not all counted")
	}
}

func scrape(t *testing.T, m *Metrics) string {
	t.Helper()
	recorder := httptest.NewRecorder()
	m.Registry().Handler().ServeHTTP(recorder, httptest.NewRequest("GET", "/metrics", nil))
	if recorder.Code != 200 {
		t.Fatalf("scrape answered %d", recorder.Code)
	}
	return recorder.Body.String()
}

// fakeTransaction satisfies sip.ServerTransaction by embedding it: every method the observer does
// not override panics if called, which is what we want — a test that reaches one has grown a
// dependency the wrapper should not have.
type fakeTransaction struct{ sip.ServerTransaction }

func (*fakeTransaction) Respond(*sip.Response) error { return nil }
