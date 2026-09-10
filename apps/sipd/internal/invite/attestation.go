package invite

import (
	"cmp"
	"encoding/base64"
	"encoding/json"
	"strings"

	"github.com/emiago/sipgo/sip"
)

// Attestation is the carrier's STIR/SHAKEN claim about the calling number, as it arrives at a
// terminating provider (ATIS-1000074, RFC 8224).
//
// VISIBILITY ONLY. Nothing here is verified by this edge: the carrier verified it and stated the
// outcome in headers, and this is that statement carried forward so a CDR can record it. It is
// never an authorisation, and it is populated ONLY for a trunk-authenticated INVITE — a digest
// phone can write a P-Asserted-Identity as easily as a From, so reading one from an internal call
// would hand every extension a spoofing surface.
type Attestation struct {
	// Level is the `attest` claim: "A", "B" or "C". Empty when the carrier stated no level.
	Level string
	// Verstat is the carrier's verification outcome parameter, lower-cased. Not enumerated: it is
	// carrier-writable text, and an unrecognised value must reach a CDR rather than fail an INVITE.
	Verstat string
	// AssertedIdentity is the P-Asserted-Identity URI verbatim (RFC 3325).
	AssertedIdentity string
	// OrigID is the `origid` claim, the originating provider's opaque call identifier.
	OrigID string
	// Signed reports whether an RFC 8224 `Identity` header was present. The token itself is not
	// carried: it is a multi-kilobyte JWS this platform does not verify, and a field nobody checks
	// that looks like proof is worse than no field.
	Signed bool
}

// Empty reports whether the INVITE said nothing at all, which is the common case on a trunk that
// has not been configured for STIR/SHAKEN.
func (a Attestation) Empty() bool {
	return a.Level == "" && a.Verstat == "" && a.AssertedIdentity == "" && a.OrigID == "" && !a.Signed
}

// maxPassportPayload bounds the base64 segment this will decode. A PASSporT payload is a few
// hundred bytes; anything larger is not one, and decoding it would put an attacker-chosen
// allocation on the INVITE path.
const maxPassportPayload = 4096

// attestationOf reads the three headers a terminating carrier uses to state its verification
// result. It performs no crypto and never fails: a header it cannot parse contributes nothing.
func attestationOf(req *sip.Request) Attestation {
	var attestation Attestation

	if pai := req.GetHeader("P-Asserted-Identity"); pai != nil {
		value := strings.TrimSpace(pai.Value())
		attestation.AssertedIdentity = value
		attestation.Verstat = verstatIn(value)
	}
	if attestation.Verstat == "" {
		if from := req.GetHeader("From"); from != nil {
			attestation.Verstat = verstatIn(from.Value())
		}
	}

	identity := req.GetHeader("Identity")
	if identity == nil {
		return attestation
	}
	attestation.Signed = true
	value := identity.Value()

	// Carriers state `attest` and `origid` two ways: as header parameters (the shape most of them
	// still send) and inside the PASSporT payload. Parameters first — they cost a scan, and the
	// payload decode is only worth doing when they are absent.
	level, origID := identityParams(value)
	if level == "" || origID == "" {
		claimLevel, claimOrigID := passportClaims(value)
		level = cmp.Or(level, claimLevel)
		origID = cmp.Or(origID, claimOrigID)
	}
	attestation.Level = normaliseLevel(level)
	attestation.OrigID = origID
	return attestation
}

// verstatIn pulls the `verstat` parameter out of a header value, wherever the carrier hung it — on
// the URI inside the angle brackets or on the header itself.
func verstatIn(value string) string {
	for part := range strings.SplitSeq(value, ";") {
		name, parameter, found := strings.Cut(strings.TrimSpace(part), "=")
		if found && strings.EqualFold(strings.TrimSpace(name), "verstat") {
			return strings.ToLower(strings.Trim(strings.TrimSpace(parameter), `>"`))
		}
	}
	return ""
}

// identityParams reads the `attest` and `origid` parameters off an Identity header.
func identityParams(value string) (level, origID string) {
	for part := range strings.SplitSeq(value, ";") {
		name, parameter, found := strings.Cut(strings.TrimSpace(part), "=")
		if !found {
			continue
		}
		parameter = strings.Trim(strings.TrimSpace(parameter), `"`)
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "attest":
			level = parameter
		case "origid":
			origID = parameter
		}
	}
	return level, origID
}

// passportClaims decodes the PASSporT payload — the middle segment of the JWS, base64url with no
// padding (RFC 7515 §2) — and reads the two claims worth surfacing. It verifies no signature: that
// is the carrier's job and this platform holds none of the certificates it would need.
func passportClaims(value string) (level, origID string) {
	token, _, _ := strings.Cut(strings.TrimSpace(value), ";")
	segments := strings.Split(token, ".")
	if len(segments) < 2 || len(segments[1]) > maxPassportPayload {
		return "", ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(segments[1], "="))
	if err != nil {
		return "", ""
	}
	var claims struct {
		Attest string `json:"attest"`
		OrigID string `json:"origid"`
	}
	if json.Unmarshal(raw, &claims) != nil {
		return "", ""
	}
	return claims.Attest, claims.OrigID
}

// normaliseLevel accepts only the three defined attestation levels; anything else is dropped rather
// than passed on as a claim the contract's vocabulary does not admit.
func normaliseLevel(level string) string {
	switch upper := strings.ToUpper(strings.TrimSpace(level)); upper {
	case "A", "B", "C":
		return upper
	default:
		return ""
	}
}
