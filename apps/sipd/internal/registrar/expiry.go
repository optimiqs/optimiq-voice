package registrar

import (
	"errors"
	"fmt"
	"time"
)

// ErrIntervalTooBrief means the device asked for a shorter registration than the policy allows.
// RFC 3261 §10.3 step 7 requires a 423 carrying Min-Expires, so the device can retry with a value
// it will actually be granted instead of hammering the registrar.
var ErrIntervalTooBrief = errors.New("registrar: requested expiry is below the minimum")

// ExpiryPolicy clamps the registration interval a device asks for.
//
// Both ends matter. Too short and every phone in the building re-REGISTERs constantly, which is how
// a registrar falls over at 09:00 on a Monday. Too long and a device that vanishes stays "reachable"
// for an hour, so calls to it ring into nowhere instead of following its no-answer path.
type ExpiryPolicy struct {
	Min     time.Duration
	Max     time.Duration
	Default time.Duration
}

// Validate checks the policy is internally consistent. Called at boot, not per-request.
func (p ExpiryPolicy) Validate() error {
	switch {
	case p.Min <= 0:
		return errors.New("registrar: the minimum expiry must be positive")
	case p.Max < p.Min:
		return fmt.Errorf("registrar: the maximum expiry (%s) is below the minimum (%s)", p.Max, p.Min)
	case p.Default < p.Min || p.Default > p.Max:
		return fmt.Errorf("registrar: the default expiry (%s) is outside [%s, %s]", p.Default, p.Min, p.Max)
	}
	return nil
}

// Grant resolves the interval to grant for a REGISTER.
//
//	stated=false          -> Default   (the request named no interval anywhere)
//	requested == 0        -> 0         (explicit de-registration; never clamped up to Min)
//	requested < Min       -> error     (ErrIntervalTooBrief; answer 423 with Min-Expires)
//	requested > Max       -> Max       (clamped down silently, as RFC 3261 §10.3 step 7 allows)
//	otherwise             -> requested
func (p ExpiryPolicy) Grant(requested time.Duration, stated bool) (time.Duration, error) {
	if !stated {
		return p.Default, nil
	}
	if requested == 0 {
		// Zero is not a short registration, it is the opposite of a registration. Clamping it up to
		// Min would keep a device bound that just told us it is going away.
		return 0, nil
	}
	if requested < p.Min {
		return 0, fmt.Errorf("%w: %s < %s", ErrIntervalTooBrief, requested, p.Min)
	}
	if requested > p.Max {
		return p.Max, nil
	}
	return requested, nil
}

// MinSeconds returns the value for the Min-Expires header of a 423 response.
func (p ExpiryPolicy) MinSeconds() int {
	return int(p.Min / time.Second)
}
