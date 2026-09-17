package trunk

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"
	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Authorizer answers a carrier challenge without exposing the carrier password to the SIP edge.
type Authorizer interface {
	Authorize(context.Context, Config, *sip.Request, *sip.Response) (*sip.Request, error)
}

type credentialRequester interface {
	RequestWithContext(context.Context, string, []byte) (*nats.Msg, error)
}

type NATSAuthorizer struct{ conn credentialRequester }

func NewNATSAuthorizer(conn *nats.Conn) *NATSAuthorizer {
	if conn == nil {
		return &NATSAuthorizer{}
	}
	return &NATSAuthorizer{conn: conn}
}

// ChallengeKey identifies a challenge so a peer cannot cause an unbounded retry loop.
func ChallengeKey(response *sip.Response) string {
	challenge, header, err := carrierChallenge(response)
	if err != nil {
		return ""
	}
	return header + ":" + challenge.Realm + ":" + challenge.Nonce
}

func carrierChallenge(response *sip.Response) (*digest.Challenge, string, error) {
	challengeHeader, authorizationHeader := "WWW-Authenticate", "Authorization"
	switch response.StatusCode {
	case 401:
	case 407:
		challengeHeader, authorizationHeader = "Proxy-Authenticate", "Proxy-Authorization"
	default:
		return nil, "", errors.New("not a carrier authentication challenge")
	}
	header := response.GetHeader(challengeHeader)
	if header == nil || len(header.Value()) > 4096 {
		return nil, "", errors.New("missing or oversized carrier challenge")
	}
	challenge, err := digest.ParseChallenge(header.Value())
	if err != nil || challenge.Realm == "" || challenge.Nonce == "" {
		return nil, "", errors.New("invalid carrier authentication challenge")
	}
	challenge.Algorithm = strings.ToUpper(challenge.Algorithm)
	if challenge.Algorithm == "" {
		challenge.Algorithm = "MD5"
	}
	switch challenge.Algorithm {
	case "MD5", "SHA-256", "SHA-512-256":
	default:
		return nil, "", errors.New("unsupported carrier digest algorithm")
	}
	for i := range challenge.QOP {
		challenge.QOP[i] = strings.TrimSpace(challenge.QOP[i])
	}
	if len(challenge.QOP) > 0 && !challenge.SupportsQOP("auth") {
		return nil, "", errors.New("unsupported carrier digest quality of protection")
	}
	return challenge, authorizationHeader, nil
}

func (a *NATSAuthorizer) Authorize(ctx context.Context, config Config, request *sip.Request, response *sip.Response) (*sip.Request, error) {
	if a.conn == nil || config.SecretRef == "" || config.AuthUser == "" {
		return nil, errors.New("carrier credential resolver is unavailable")
	}
	challenge, header, err := carrierChallenge(response)
	if err != nil {
		return nil, err
	}
	if request.Method != sip.REGISTER && request.Method != sip.INVITE {
		return nil, errors.New("carrier authentication is only supported for REGISTER and INVITE")
	}
	payload, err := json.Marshal(contract.SipTrunkCredentialRequest{
		OrgID: config.OrgID, TrunkID: config.TrunkID, SecretRef: config.SecretRef,
		Username: config.AuthUser, Realm: challenge.Realm,
		Algorithm: contract.SipTrunkCredentialRequestAlgorithm(challenge.Algorithm),
	})
	if err != nil {
		return nil, errors.New("cannot encode carrier credential request")
	}
	ctx, cancel := context.WithTimeout(ctx, contract.TimeoutSipTrunkCredentialRPC)
	defer cancel()
	message, err := a.conn.RequestWithContext(ctx, contract.SubjectSipTrunkCredentialRPC, payload)
	if err != nil {
		return nil, errors.New("carrier credential lookup failed")
	}
	var reply contract.SipTrunkCredentialResponse
	if err := json.Unmarshal(message.Data, &reply); err != nil || !reply.Ok ||
		reply.OrgID == nil || *reply.OrgID != config.OrgID ||
		reply.TrunkID == nil || *reply.TrunkID != config.TrunkID ||
		reply.Username == nil || *reply.Username != config.AuthUser ||
		reply.Realm == nil || *reply.Realm != challenge.Realm ||
		reply.Algorithm == nil || string(*reply.Algorithm) != challenge.Algorithm ||
		reply.Ha1 == nil {
		return nil, errors.New("carrier credential lookup was refused")
	}
	hash, err := hex.DecodeString(*reply.Ha1)
	expectedBytes := 32
	if challenge.Algorithm == "MD5" {
		expectedBytes = 16
	}
	if err != nil || len(hash) != expectedBytes {
		return nil, errors.New("invalid carrier digest")
	}
	credential, err := digest.Digest(challenge, digest.Options{
		Username: config.AuthUser, A1: *reply.Ha1,
		Method: request.Method.String(), URI: request.Recipient.String(), Count: 1,
	})
	if err != nil {
		return nil, errors.New("cannot answer carrier digest challenge")
	}
	authorized := request.Clone()
	if authorized.CSeq() == nil {
		return nil, errors.New("carrier request has no sequence number")
	}
	authorized.CSeq().SeqNo++
	authorized.RemoveHeader("Via")
	authorized.RemoveHeader(header)
	authorized.AppendHeader(sip.NewHeader(header, credential.String()))
	return authorized, nil
}
