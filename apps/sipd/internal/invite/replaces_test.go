package invite_test

import (
	"errors"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/invite"
)

// Same grammar as the Refer-To's URI header, arriving in a different encoding. A parser that
// assumed one of them would silently fail on the other — and for an attended transfer that means
// the consultation call stays up while the target is dialled as a fresh call.
func TestParseReplacesHeader(t *testing.T) {
	cases := []struct {
		name      string
		value     string
		callID    string
		toTag     string
		fromTag   string
		earlyOnly bool
		wantErr   bool
	}{
		{
			name:    "the ordinary header form",
			value:   "a84b4c76e66710@pc33;to-tag=abc;from-tag=def",
			callID:  "a84b4c76e66710@pc33",
			toTag:   "abc",
			fromTag: "def",
		},
		{
			name:      "early-only is a flag with no value",
			value:     "call-1;to-tag=abc;from-tag=def;early-only",
			callID:    "call-1",
			toTag:     "abc",
			fromTag:   "def",
			earlyOnly: true,
		},
		{
			name:    "parameter order does not matter",
			value:   "call-1;from-tag=def;to-tag=abc",
			callID:  "call-1",
			toTag:   "abc",
			fromTag: "def",
		},
		{
			name:    "quoted tags are unquoted",
			value:   `call-1;to-tag="abc";from-tag="def"`,
			callID:  "call-1",
			toTag:   "abc",
			fromTag: "def",
		},
		{
			name:    "whitespace is tolerated",
			value:   " call-1 ; to-tag = abc ; from-tag = def ",
			callID:  "call-1",
			toTag:   "abc",
			fromTag: "def",
		},
		{
			// A phone that copied the value out of a Refer-To without unescaping it is a real bug in
			// the field, and unescaping something that needs none is a no-op.
			name:    "a percent-encoded value from a copied Refer-To still parses",
			value:   "call-1%3Bto-tag%3Dabc%3Bfrom-tag%3Ddef",
			callID:  "call-1",
			toTag:   "abc",
			fromTag: "def",
		},
		{"no to-tag is refused", "call-1;from-tag=def", "", "", "", false, true},
		{"no from-tag is refused", "call-1;to-tag=abc", "", "", "", false, true},
		{"no tags at all is refused", "call-1", "", "", "", false, true},
		{"no call-id is refused", ";to-tag=abc;from-tag=def", "", "", "", false, true},
		{"an empty value is refused", "", "", "", "", false, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := invite.ParseReplacesHeader(tc.value)
			if tc.wantErr {
				if !errors.Is(err, invite.ErrMalformedReplaces) {
					t.Fatalf("err = %v, want ErrMalformedReplaces", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseReplacesHeader: %v", err)
			}
			switch {
			case got.CallID != tc.callID:
				t.Errorf("callId = %q, want %q", got.CallID, tc.callID)
			case got.ToTag != tc.toTag:
				t.Errorf("toTag = %q, want %q", got.ToTag, tc.toTag)
			case got.FromTag != tc.fromTag:
				t.Errorf("fromTag = %q, want %q", got.FromTag, tc.fromTag)
			case got.EarlyOnly != tc.earlyOnly:
				t.Errorf("earlyOnly = %v, want %v", got.EarlyOnly, tc.earlyOnly)
			}
		})
	}
}
