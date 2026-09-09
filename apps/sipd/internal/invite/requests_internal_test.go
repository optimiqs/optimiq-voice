package invite

import (
	"github.com/emiago/sipgo/sip"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/nat"
	"testing"
)

func TestInDialogRequestsTraverseStrictAndLooseRoutes(t *testing.T) {
	for _, tc := range []struct {
		name                   string
		routes                 []string
		recipient, destination string
		headers                []string
	}{
		{"direct", nil, "sip:callee@phone.example:5070", "phone.example:5070", nil},
		{"loose", []string{"<sip:proxy.example:5080;lr>", "<sip:next.example;lr>"}, "sip:callee@phone.example:5070", "proxy.example:5080", []string{"<sip:proxy.example:5080;lr>", "<sip:next.example;lr>"}},
		{"strict", []string{"<sip:strict.example:5090>", "<sip:next.example;lr>"}, "sip:strict.example:5090", "strict.example:5090", []string{"<sip:next.example;lr>", "<sip:callee@phone.example:5070>"}},
		{"secure strict IPv6", []string{"<sips:[2001:db8::1]>"}, "sips:[2001:db8::1]", "[2001:db8::1]:5061", []string{"<sip:callee@phone.example:5070>"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &dialog.Dialog{Target: dialog.Target{Contact: sip.Uri{Scheme: "sip", User: "callee", Host: "phone.example", Port: 5070}, RouteSet: tc.routes, Transport: "udp"}}
			for _, method := range []sip.RequestMethod{sip.BYE, sip.ACK, sip.UPDATE, sip.INVITE} {
				req := buildInDialog(method, d, sip.Uri{}, sip.Uri{}, 42, nat.Policy{ContactRewrite: nat.ModeNever}, sip.Uri{})
				if req.Recipient.String() != tc.recipient || req.Destination() != tc.destination {
					t.Fatalf("%s: recipient=%s destination=%s", method, req.Recipient.String(), req.Destination())
				}
				routes := req.GetHeaders("Route")
				if len(routes) != len(tc.headers) {
					t.Fatalf("route count=%d, want %d", len(routes), len(tc.headers))
				}
				for index, header := range routes {
					if header.Value() != tc.headers[index] {
						t.Fatalf("route %d=%s, want %s", index, header.Value(), tc.headers[index])
					}
				}
			}
		})
	}
}
