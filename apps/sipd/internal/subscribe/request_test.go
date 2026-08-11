package subscribe

import (
	"strings"
	"testing"
)

// The header parsers are the first thing a SUBSCRIBE from the internet touches, so the cases below
// are the hostile ones as much as the ordinary ones.

func TestParseEvent(t *testing.T) {
	cases := []struct {
		header string
		event  EventPackage
		id     string
		ok     bool
	}{
		{"dialog", EventDialog, "", true},
		{"dialog;id=key07", EventDialog, "key07", true},
		{" DIALOG ; ID = key07 ", EventDialog, "key07", true},
		{`dialog;id="key07"`, EventDialog, "key07", true},
		{"message-summary", EventMessageSummary, "", true},
		{"dialog;shared;id=7", EventDialog, "7", true},
		{"", "", "", false},
		{";id=7", "", "", false},
		// Unknown packages parse fine and are refused later, by Supported — the parser's job is not
		// to know the catalogue.
		{"presence", EventPackage("presence"), "", true},
	}

	for _, testCase := range cases {
		event, id, ok := parseEvent(testCase.header)
		if ok != testCase.ok || event != testCase.event || id != testCase.id {
			t.Errorf("parseEvent(%q) = (%q, %q, %v), want (%q, %q, %v)",
				testCase.header, event, id, ok, testCase.event, testCase.id, testCase.ok)
		}
	}
}

// The Event `id` is the ONLY device-controlled string this package puts into a header it composes.
// Anything that could break the header — or forge one — is dropped rather than echoed.
func TestParseEventDropsAnIDThatCouldForgeAHeader(t *testing.T) {
	for _, hostile := range []string{
		"a\r\nSubscription-State: terminated",
		"a b",
		strings.Repeat("x", 65),
		"a@b",
		`a"b`,
	} {
		_, id, ok := parseEvent("dialog;id=" + hostile)
		if !ok {
			t.Errorf("parseEvent refused the whole header for a bad id %q", hostile)
			continue
		}
		if id != "" {
			t.Errorf("parseEvent kept a hostile id %q as %q", hostile, id)
		}
	}
}

func TestAcceptable(t *testing.T) {
	cases := []struct {
		accept string
		want   bool
	}{
		// Absent means yes: RFC 6665 §4.2.1 says the notifier assumes the package's default body
		// type, which is the one we send, and several handsets omit the header entirely.
		{"", true},
		{"application/dialog-info+xml", true},
		{"*/*", true},
		{"application/*", true},
		{" APPLICATION/DIALOG-INFO+XML ", true},
		{"application/pidf+xml, application/dialog-info+xml;q=0.8", true},
		{"application/dialog-info+xml;q=0", true},
		{"application/pidf+xml", false},
		{"text/*", false},
	}

	for _, testCase := range cases {
		if got := acceptable(testCase.accept, dialogInfoContentType); got != testCase.want {
			t.Errorf("acceptable(%q) = %v, want %v", testCase.accept, got, testCase.want)
		}
	}
}

func TestExpiryPolicyGrant(t *testing.T) {
	policy := ExpiryPolicy{Min: 60, Max: 600, Default: 600}

	if granted, err := policy.Grant(0, false); err != nil || granted != 600 {
		t.Errorf("an unstated interval granted (%v, %v), want the default", granted, err)
	}
	if granted, err := policy.Grant(0, true); err != nil || granted != 0 {
		t.Errorf("Expires: 0 granted (%v, %v); it is an unsubscribe, not a refusal", granted, err)
	}
	if _, err := policy.Grant(5, true); err == nil {
		t.Error("a too-brief interval was granted")
	}
	if granted, err := policy.Grant(3600, true); err != nil || granted != 600 {
		t.Errorf("an overlong interval granted (%v, %v), want the clamped maximum", granted, err)
	}
	if granted, err := policy.Grant(300, true); err != nil || granted != 300 {
		t.Errorf("a legal interval granted (%v, %v), want it unchanged", granted, err)
	}
}

func TestExpiryPolicyValidate(t *testing.T) {
	for _, bad := range []ExpiryPolicy{
		{},
		{Min: 0, Max: 600, Default: 600},
		{Min: 600, Max: 60, Default: 60},
		{Min: 60, Max: 600, Default: 30},
		{Min: 60, Max: 600, Default: 900},
	} {
		if err := bad.Validate(); err == nil {
			t.Errorf("%#v validated", bad)
		}
	}
	if err := (ExpiryPolicy{Min: 60, Max: 600, Default: 600}).Validate(); err != nil {
		t.Errorf("a sane policy was refused: %v", err)
	}
}
