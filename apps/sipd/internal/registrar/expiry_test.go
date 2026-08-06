package registrar

import (
	"errors"
	"testing"
	"time"
)

func TestExpiryPolicyGrant(t *testing.T) {
	policy := ExpiryPolicy{
		Min:     60 * time.Second,
		Max:     3600 * time.Second,
		Default: 300 * time.Second,
	}

	cases := []struct {
		name      string
		requested time.Duration
		stated    bool
		want      time.Duration
		wantErr   error
	}{
		{"no interval stated falls back to the default", 0, false, 300 * time.Second, nil},
		{"zero is a de-registration, never clamped up", 0, true, 0, nil},
		{"exactly the minimum is granted", 60 * time.Second, true, 60 * time.Second, nil},
		{"below the minimum is refused", 59 * time.Second, true, 0, ErrIntervalTooBrief},
		{"one second is refused", time.Second, true, 0, ErrIntervalTooBrief},
		{"inside the range is granted verbatim", 900 * time.Second, true, 900 * time.Second, nil},
		{"exactly the maximum is granted", 3600 * time.Second, true, 3600 * time.Second, nil},
		{"above the maximum is clamped down", 86400 * time.Second, true, 3600 * time.Second, nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := policy.Grant(tc.requested, tc.stated)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if tc.wantErr == nil && got != tc.want {
				t.Errorf("granted %s, want %s", got, tc.want)
			}
		})
	}
}

func TestExpiryPolicyValidate(t *testing.T) {
	cases := []struct {
		name    string
		policy  ExpiryPolicy
		wantErr bool
	}{
		{"consistent", ExpiryPolicy{Min: 60 * time.Second, Max: time.Hour, Default: 5 * time.Minute}, false},
		{"min == max == default", ExpiryPolicy{Min: time.Minute, Max: time.Minute, Default: time.Minute}, false},
		{"zero minimum", ExpiryPolicy{Min: 0, Max: time.Hour, Default: time.Minute}, true},
		{"max below min", ExpiryPolicy{Min: time.Hour, Max: time.Minute, Default: time.Minute}, true},
		{"default below min", ExpiryPolicy{Min: time.Minute, Max: time.Hour, Default: time.Second}, true},
		{"default above max", ExpiryPolicy{Min: time.Minute, Max: time.Hour, Default: 2 * time.Hour}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.policy.Validate()
			if (err != nil) != tc.wantErr {
				t.Errorf("err = %v, wantErr = %v", err, tc.wantErr)
			}
		})
	}
}

func TestMinSecondsIsWhatGoesInTheHeader(t *testing.T) {
	policy := ExpiryPolicy{Min: 90 * time.Second, Max: time.Hour, Default: 5 * time.Minute}
	if got := policy.MinSeconds(); got != 90 {
		t.Errorf("MinSeconds = %d, want 90", got)
	}
}
