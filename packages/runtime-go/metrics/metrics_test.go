package metrics

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerExposesRegisteredAndRuntimeCollectors(t *testing.T) {
	registry := New("sipd")
	registry.Counter("registrations_total", "REGISTERs accepted.").Add(3)
	registry.CounterVec("refusals_total", "Requests refused.", "reason").WithLabelValues("no_such_account").Inc()
	registry.GaugeFunc("dialogs", "Dialogs in progress.", func() float64 { return 7 })

	recorder := httptest.NewRecorder()
	registry.Handler().ServeHTTP(recorder, httptest.NewRequest("GET", "/metrics", nil))
	if recorder.Code != 200 {
		t.Fatalf("scrape answered %d", recorder.Code)
	}
	body := recorder.Body.String()
	for _, want := range []string{
		"sipd_registrations_total 3",
		`sipd_refusals_total{reason="no_such_account"} 1`,
		"sipd_dialogs 7",
		// The process and Go collectors keep their conventional unprefixed names.
		"go_goroutines",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("scrape is missing %q", want)
		}
	}
	if strings.Contains(body, "sipd_go_goroutines") {
		t.Error("the namespace leaked onto the Go runtime collector")
	}
}

// Two services in one process must not collide, which is the whole reason the registry is private.
func TestRegistriesAreIndependent(t *testing.T) {
	first := New("sipd")
	second := New("mediad")
	first.Counter("sessions_total", "Sessions.").Inc()
	second.Counter("sessions_total", "Sessions.").Inc()
}
