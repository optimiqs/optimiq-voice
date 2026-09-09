package invite

import (
	"context"
	"encoding/json"
	"fmt"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

type RenegotiationPort interface {
	Renegotiate(context.Context, string, contract.EngineRenegotiateRequest) (string, error)
}

func (p *NATSPort) Renegotiate(ctx context.Context, engineInstance string, request contract.EngineRenegotiateRequest) (string, error) {
	token, err := contract.InstanceSubjectToken(engineInstance)
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, contract.TimeoutEngineRenegotiateRPC)
	defer cancel()
	message, err := p.conn.RequestWithContext(ctx, contract.SubjectEngineRenegotiateRPC+"."+token, payload)
	if err != nil {
		return "", err
	}
	var reply contract.EngineRenegotiateResponse
	if err := json.Unmarshal(message.Data, &reply); err != nil {
		return "", err
	}
	if !reply.Ok || reply.LegID != request.LegID || reply.SDPAnswer == nil || *reply.SDPAnswer == "" {
		return "", fmt.Errorf("engine refused SDP negotiation for leg %s", request.LegID)
	}
	return *reply.SDPAnswer, nil
}
