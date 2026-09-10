package sipua

import (
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"

	"github.com/emiago/sipgo/sip"
)

// Dialog is one INVITE dialog this UA originated or answered.
type Dialog struct {
	ua         *UA
	Target     string
	toTag      string
	fromTag    string
	callID     string
	inviteCSeq int
	// RemoteSDP is the far end's answer or offer, whichever arrived last.
	RemoteSDP string
	// RemoteContact is the far end's Contact, which mid-dialog requests are aimed at.
	RemoteContact string
	inbound       bool
	inviteRequest *sip.Request
	lastBranch    string
	lastVia       string
	remoteURI     string
}

// Invite offers a session to target and returns the final response, answering one digest challenge.
func (u *UA) Invite(target, sdp string) (*sip.Response, *Dialog, error) {
	dialog := &Dialog{ua: u, Target: target, fromTag: u.fromTag, callID: u.callID}
	response, err := dialog.sendInvite("", sdp)
	if err != nil {
		return nil, dialog, err
	}
	if response.StatusCode == 401 || response.StatusCode == 407 {
		// The transaction the challenge belongs to must be acknowledged before the retry
		// (RFC 3261 §17.1.1.2).
		if err := dialog.ackFailure(response); err != nil {
			return nil, dialog, err
		}
		authorization, err := u.Answer(response, "INVITE", target, RegisterOptions{})
		if err != nil {
			return nil, dialog, err
		}
		dialog.toTag = ""
		response, err = dialog.sendInvite(authorization, sdp)
		if err != nil {
			return nil, dialog, err
		}
	}
	return response, dialog, nil
}

// AwaitFinal reads responses until a final one arrives, recording provisional statuses.
func (d *Dialog) AwaitFinal() (*sip.Response, []int, error) {
	provisional := make([]int, 0, 4)
	for {
		response, err := d.ua.Read()
		if err != nil {
			return nil, provisional, err
		}
		d.absorb(response)
		if response.StatusCode < 200 {
			provisional = append(provisional, response.StatusCode)
			continue
		}
		return response, provisional, nil
	}
}

func (d *Dialog) absorb(response *sip.Response) {
	if to := response.To(); to != nil {
		if tag, present := to.Params.Get("tag"); present {
			d.toTag = tag
		}
	}
	if body := string(response.Body()); body != "" {
		d.RemoteSDP = body
	}
	if contact := response.GetHeader("Contact"); contact != nil {
		d.RemoteContact = contactURI(contact.Value())
	}
}

func (d *Dialog) sendInvite(authorization, sdp string) (*sip.Response, error) {
	d.ua.cseq++
	d.inviteCSeq = d.ua.cseq
	if err := d.write("INVITE", d.inviteCSeq, sdp, authorization); err != nil {
		return nil, err
	}
	response, _, err := d.AwaitFinal()
	return response, err
}

// Ack acknowledges a 2xx. Its CSeq repeats the INVITE's (RFC 3261 §13.2.2.4).
func (d *Dialog) Ack() error { return d.write("ACK", d.inviteCSeq, "", "") }

// ackFailure acknowledges a non-2xx final response inside the INVITE transaction.
func (d *Dialog) ackFailure(response *sip.Response) error {
	return d.writeTo(d.Target, "ACK", d.inviteCSeq, "", "", branchOf(response))
}

// ReInvite renegotiates the session — hold and resume are both this with a different direction.
func (d *Dialog) ReInvite(sdp string) (*sip.Response, error) {
	d.ua.cseq++
	d.inviteCSeq = d.ua.cseq
	if err := d.write("INVITE", d.inviteCSeq, sdp, ""); err != nil {
		return nil, err
	}
	response, _, err := d.AwaitFinal()
	if err != nil {
		return nil, err
	}
	if response.StatusCode/100 == 2 {
		return response, d.Ack()
	}
	return response, nil
}

// Bye ends the dialog.
func (d *Dialog) Bye() (*sip.Response, error) {
	d.ua.cseq++
	if err := d.write("BYE", d.ua.cseq, "", ""); err != nil {
		return nil, err
	}
	response, _, err := d.AwaitFinal()
	return response, err
}

// Cancel withdraws an INVITE that has not been answered. It repeats the INVITE's CSeq and branch.
func (d *Dialog) Cancel() error {
	return d.writeTo(d.Target, "CANCEL", d.inviteCSeq, "", "", d.lastBranch)
}

func (d *Dialog) write(method string, cseq int, body, authorization string) error {
	target := d.Target
	if d.RemoteContact != "" && method != "CANCEL" {
		target = d.RemoteContact
	}
	return d.writeTo(target, method, cseq, body, authorization, "")
}

func (d *Dialog) writeTo(target, method string, cseq int, body, authorization, branch string) error {
	local := d.ua.LocalAddr()
	if branch == "" {
		branch = fmt.Sprintf("z9hG4bK%s%s%d", d.fromTag, strings.ToLower(method), cseq)
		if method == "INVITE" {
			d.lastBranch = branch
		}
	}
	lines := []string{
		method + " " + target + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/%s %s;branch=%s;rport", d.ua.viaProtocol(), local, branch),
		"Max-Forwards: 70",
		"From: <sip:" + d.ua.User + "@" + d.ua.Realm + ">;tag=" + d.fromTag,
		"To: <" + d.Target + ">" + tagParam(d.toTag),
		"Call-ID: " + d.callID,
		"CSeq: " + strconv.Itoa(cseq) + " " + method,
		"Contact: <sip:" + d.ua.User + "@" + local + ";transport=" + d.ua.contactTransport() + ">",
		"User-Agent: sipua-e2e",
		"Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, UPDATE, NOTIFY, REFER",
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	if body != "" {
		lines = append(lines, "Content-Type: application/sdp", "Content-Length: "+strconv.Itoa(len(body)), "", body)
	} else {
		lines = append(lines, "Content-Length: 0", "", "")
	}
	return d.ua.WriteRaw([]byte(strings.Join(lines, "\r\n")))
}

func tagParam(tag string) string {
	if tag == "" {
		return ""
	}
	return ";tag=" + tag
}

var branchPattern = regexp.MustCompile(`branch=([^;,\s]+)`)

func branchOf(response *sip.Response) string {
	if via := response.GetHeader("Via"); via != nil {
		if match := branchPattern.FindStringSubmatch(via.Value()); match != nil {
			return match[1]
		}
	}
	return ""
}

// contactURI strips the display name and angle brackets from a Contact value.
func contactURI(value string) string {
	if start := strings.Index(value, "<"); start >= 0 {
		if end := strings.Index(value[start:], ">"); end > 0 {
			return value[start+1 : start+end]
		}
	}
	return strings.TrimSpace(strings.Split(value, ";")[0])
}

// MediaPort is the `m=audio` port of an SDP body, and whether one was found.
func MediaPort(sdp string) (int, bool) {
	for line := range strings.SplitSeq(sdp, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) >= 2 && strings.HasPrefix(fields[0], "m=audio") {
			port, err := strconv.Atoi(fields[1])
			return port, err == nil
		}
	}
	return 0, false
}

// MediaAddress is the `c=` connection address of an SDP body.
func MediaAddress(sdp string) string {
	for line := range strings.SplitSeq(sdp, "\n") {
		trimmed := strings.TrimSpace(line)
		if after, found := strings.CutPrefix(trimmed, "c=IN IP4 "); found {
			return strings.TrimSpace(after)
		}
	}
	return ""
}

// MediaTarget joins the SDP's connection address and audio port into a "host:port" an RTPSender takes.
func MediaTarget(sdp string) (string, bool) {
	port, found := MediaPort(sdp)
	address := MediaAddress(sdp)
	if !found || address == "" || port == 0 {
		return "", false
	}
	return net.JoinHostPort(address, strconv.Itoa(port)), true
}

// AwaitInvite blocks until an INVITE arrives on this UA's socket, returning it and a dialog that can
// answer it. Non-INVITE requests and stray responses are skipped.
func (u *UA) AwaitInvite() (*sip.Request, *Dialog, error) {
	for {
		message, err := u.ReadMessage()
		if err != nil {
			return nil, nil, err
		}
		request, ok := message.(*sip.Request)
		if !ok || request.Method != sip.INVITE {
			continue
		}
		dialog := &Dialog{
			ua: u, inbound: true, inviteRequest: request,
			callID:  headerText(request, "Call-ID"),
			toTag:   "uas" + u.fromTag,
			Target:  request.Recipient.String(),
			lastVia: headerText(request, "Via"),
		}
		if from := request.From(); from != nil {
			if tag, present := from.Params.Get("tag"); present {
				dialog.fromTag = tag
			}
			dialog.remoteURI = from.Address.String()
		}
		if contact := request.GetHeader("Contact"); contact != nil {
			dialog.RemoteContact = contactURI(contact.Value())
		}
		dialog.RemoteSDP = string(request.Body())
		dialog.inviteCSeq = cseqNumber(request)
		return request, dialog, nil
	}
}

// Respond answers an inbound INVITE. A 2xx carries the SDP answer; a provisional carries none.
func (d *Dialog) Respond(status int, reason, sdp string) error {
	lines := []string{
		"SIP/2.0 " + strconv.Itoa(status) + " " + reason,
		"Via: " + d.lastVia,
		"From: <" + d.remoteURI + ">;tag=" + d.fromTag,
		"To: <" + d.Target + ">;tag=" + d.toTag,
		"Call-ID: " + d.callID,
		"CSeq: " + strconv.Itoa(d.inviteCSeq) + " INVITE",
		"Contact: <sip:" + d.ua.User + "@" + d.ua.LocalAddr() + ";transport=" + d.ua.contactTransport() + ">",
		"Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, UPDATE",
		"User-Agent: sipua-e2e",
	}
	if sdp != "" {
		lines = append(lines, "Content-Type: application/sdp", "Content-Length: "+strconv.Itoa(len(sdp)), "", sdp)
	} else {
		lines = append(lines, "Content-Length: 0", "", "")
	}
	return d.ua.WriteRaw([]byte(strings.Join(lines, "\r\n")))
}

// AwaitRequest reads until a request of the given method arrives.
func (u *UA) AwaitRequest(method sip.RequestMethod) (*sip.Request, error) {
	for {
		message, err := u.ReadMessage()
		if err != nil {
			return nil, err
		}
		if request, ok := message.(*sip.Request); ok && request.Method == method {
			return request, nil
		}
	}
}

// RespondTo answers an arbitrary in-dialog request with a status and no body.
func (d *Dialog) RespondTo(request *sip.Request, status int, reason string) error {
	lines := []string{
		"SIP/2.0 " + strconv.Itoa(status) + " " + reason,
		"Via: " + headerText(request, "Via"),
		"From: " + headerText(request, "From"),
		"To: " + headerText(request, "To"),
		"Call-ID: " + headerText(request, "Call-ID"),
		"CSeq: " + headerText(request, "CSeq"),
		"Content-Length: 0", "", "",
	}
	return d.ua.WriteRaw([]byte(strings.Join(lines, "\r\n")))
}

type headerGetter interface{ GetHeader(string) sip.Header }

func headerText(message headerGetter, name string) string {
	if header := message.GetHeader(name); header != nil {
		return header.Value()
	}
	return ""
}

func cseqNumber(request *sip.Request) int {
	fields := strings.Fields(headerText(request, "CSeq"))
	if len(fields) == 0 {
		return 1
	}
	value, err := strconv.Atoi(fields[0])
	if err != nil {
		return 1
	}
	return value
}

// InviteAsync sends an authenticated INVITE and returns as soon as it is on the wire, so the caller
// can drive the far end before waiting for the final response. Use AwaitFinal to collect it.
func (u *UA) InviteAsync(target, sdp string) (*Dialog, error) {
	dialog := &Dialog{ua: u, Target: target, fromTag: u.fromTag, callID: u.callID}
	response, err := dialog.sendInvite("", sdp)
	if err != nil {
		return dialog, err
	}
	if response.StatusCode != 401 && response.StatusCode != 407 {
		return dialog, fmt.Errorf("sipua: expected a challenge, got %d %s", response.StatusCode, response.Reason)
	}
	if err := dialog.ackFailure(response); err != nil {
		return dialog, err
	}
	authorization, err := u.Answer(response, "INVITE", target, RegisterOptions{})
	if err != nil {
		return dialog, err
	}
	dialog.toTag = ""
	u.cseq++
	dialog.inviteCSeq = u.cseq
	return dialog, dialog.write("INVITE", dialog.inviteCSeq, sdp, authorization)
}

// InviteAsyncNoAuth sends one INVITE and returns without waiting, for a profile that authenticates
// by source address rather than by digest.
func (u *UA) InviteAsyncNoAuth(target, sdp string) (*Dialog, error) {
	dialog := &Dialog{ua: u, Target: target, fromTag: u.fromTag, callID: u.callID}
	u.cseq++
	dialog.inviteCSeq = u.cseq
	return dialog, dialog.write("INVITE", dialog.inviteCSeq, sdp, "")
}
