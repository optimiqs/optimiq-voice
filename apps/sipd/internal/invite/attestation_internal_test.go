package invite

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/emiago/sipgo/sip"
)

// passport renders a PASSporT-shaped JWS whose payload carries the claims. Only the payload segment
// is read, so the header and signature are placeholders.
func passport(t *testing.T, claims string) string {
	t.Helper()
	return "eyJhbGciOiJFUzI1NiJ9." + base64.RawURLEncoding.EncodeToString([]byte(claims)) + ".sig"
}

func inviteWith(t *testing.T, headers ...string) *sip.Request {
	t.Helper()
	lines := []string{
		"INVITE sip:1601@example.test SIP/2.0",
		"Via: SIP/2.0/UDP 198.51.100.4:5060;branch=z9hG4bKcarrier",
		"Max-Forwards: 70",
		"To: <sip:1601@example.test>",
		"Call-ID: attest-1@carrier",
		"CSeq: 1 INVITE",
		"Contact: <sip:carrier@198.51.100.4:5060>",
	}
	lines = append(lines, headers...)
	req, err := sip.NewParser().ParseSIP([]byte(strings.Join(lines, "\r\n") + "\r\n\r\n"))
	if err != nil {
		t.Fatalf("ParseSIP: %v", err)
	}
	request, ok := req.(*sip.Request)
	if !ok {
		t.Fatal("the fixture did not parse as a request")
	}
	return request
}

func TestAnAttestationIsReadFromTheCarrierHeaders(t *testing.T) {
	for _, tc := range []struct {
		name    string
		headers []string
		want    Attestation
	}{
		{
			name:    "nothing at all",
			headers: []string{"From: <sip:+15551230000@carrier.example>;tag=t"},
			want:    Attestation{},
		},
		{
			name: "verstat on the P-Asserted-Identity",
			headers: []string{
				"From: <sip:+15551230000@carrier.example>;tag=t",
				"P-Asserted-Identity: <sip:+15551230000@carrier.example;verstat=TN-Validation-Passed>",
			},
			want: Attestation{
				AssertedIdentity: "<sip:+15551230000@carrier.example;verstat=TN-Validation-Passed>",
				Verstat:          "tn-validation-passed",
			},
		},
		{
			// Some carriers hang it on the From instead; a CDR must record it either way.
			name:    "verstat on the From",
			headers: []string{"From: <sip:+15551230000@carrier.example;verstat=No-TN-Validation>;tag=t"},
			want:    Attestation{Verstat: "no-tn-validation"},
		},
		{
			name: "attest and origid as Identity parameters",
			headers: []string{
				"From: <sip:+15551230000@carrier.example>;tag=t",
				"Identity: " + passport(t, `{"attest":"C"}`) + `;info=<https://c.example/c.pem>;attest=A;origid=abc-123`,
			},
			want: Attestation{Signed: true, Level: "A", OrigID: "abc-123"},
		},
		{
			// No parameters, so the PASSporT payload is decoded instead.
			name: "attest and origid from the PASSporT payload",
			headers: []string{
				"From: <sip:+15551230000@carrier.example>;tag=t",
				"Identity: " + passport(t, `{"attest":"B","origid":"payload-1"}`) + ";info=<https://c.example/c.pem>",
			},
			want: Attestation{Signed: true, Level: "B", OrigID: "payload-1"},
		},
		{
			// A level outside A/B/C is not in the contract's vocabulary and is dropped rather than
			// passed on; the header's presence is still recorded.
			name: "an unknown attestation level is dropped",
			headers: []string{
				"From: <sip:+15551230000@carrier.example>;tag=t",
				"Identity: " + passport(t, `{"attest":"Z"}`),
			},
			want: Attestation{Signed: true},
		},
		{
			name: "a payload that is not base64 contributes nothing",
			headers: []string{
				"From: <sip:+15551230000@carrier.example>;tag=t",
				"Identity: header.!!!not-base64!!!.sig",
			},
			want: Attestation{Signed: true},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := attestationOf(inviteWith(t, tc.headers...))
			if got != tc.want {
				t.Fatalf("attestationOf() = %+v, want %+v", got, tc.want)
			}
			if got.Empty() != (tc.want == Attestation{}) {
				t.Fatalf("Empty() = %v for %+v", got.Empty(), got)
			}
		})
	}
}

// A digest-authenticated phone can write a P-Asserted-Identity as easily as a From, so reading one
// from an internal call would hand every extension a spoofing surface.
func TestOnlyATrunkINVITECarriesAnAttestation(t *testing.T) {
	headers := []string{
		"From: <sip:1601@example.test>;tag=t",
		"P-Asserted-Identity: <sip:+15550000000@example.test;verstat=TN-Validation-Passed>",
		"Identity: " + passport(t, `{"attest":"A","origid":"spoofed"}`),
	}

	digested, err := Parse(inviteWith(t, headers...), ParseOptions{Authentication: AuthenticationDigest})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !digested.Attestation.Empty() {
		t.Fatalf("a digest-authenticated INVITE carried an attestation: %+v", digested.Attestation)
	}

	trunked, err := Parse(inviteWith(t, headers...), ParseOptions{Authentication: AuthenticationTrunkACL})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if trunked.Attestation.Level != "A" || trunked.Attestation.Verstat != "tn-validation-passed" {
		t.Fatalf("the trunk INVITE lost its attestation: %+v", trunked.Attestation)
	}
}

func TestAnAttestationReachesTheAdmissionRequest(t *testing.T) {
	intent := CallIntent{
		LegID: "leg", InstanceID: "sipd-1", SIPCallID: "call",
		Attestation: Attestation{Level: "B", Verstat: "tn-validation-failed", OrigID: "o-1", Signed: true},
	}
	request := admissionRequest(intent)
	if request.Attestation == nil {
		t.Fatal("the admission request carried no attestation")
	}
	if request.Attestation.Level == nil || string(*request.Attestation.Level) != "B" {
		t.Fatalf("level = %v", request.Attestation.Level)
	}
	if !request.Attestation.Signed {
		t.Fatal("the signed marker was lost")
	}

	if admissionRequest(CallIntent{LegID: "leg"}).Attestation != nil {
		t.Fatal("an INVITE with no attestation still sent one")
	}
}
