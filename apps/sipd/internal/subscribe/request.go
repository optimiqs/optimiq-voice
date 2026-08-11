package subscribe

import (
	"strconv"
	"strings"
	"time"

	"github.com/emiago/sipgo/sip"
)

// Request-header helpers. Every one of them is total over a hostile input: a SUBSCRIBE arrives from
// the internet, and the parsers below are the first thing it touches.

// parseEvent splits an `Event` header into its package and its `id` parameter.
//
//	Event: dialog;id=1234
//
// The id is not decoration: RFC 6665 §8.2.1 makes it part of the subscription's identity, so two
// line keys on one phone can watch two extensions over ONE dialog, and every notification has to
// echo the id it belongs to. Dropping it silently is how a sixteen-key expansion module ends up with
// every lamp showing the same extension.
func parseEvent(value string) (EventPackage, string, bool) {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return "", "", false
	}

	parts := strings.Split(raw, ";")
	name := strings.ToLower(strings.TrimSpace(parts[0]))
	if name == "" {
		return "", "", false
	}

	var id string
	for _, parameter := range parts[1:] {
		key, rest, found := strings.Cut(parameter, "=")
		if !found || !strings.EqualFold(strings.TrimSpace(key), "id") {
			continue
		}
		id = strings.Trim(strings.TrimSpace(rest), `"`)
		break
	}
	// The id becomes a header value on the way back out, so anything that could break the header —
	// or forge one — is dropped rather than echoed. That is the CRLF-injection case sipgo's SECURITY
	// note is about, and this is the only device-controlled string this package puts in a header.
	if !safeEventID(id) {
		id = ""
	}
	return EventPackage(name), id, true
}

// safeEventID reports whether an Event `id` may be echoed into a header. RFC 3261's `token`
// production, which is what the grammar allows there anyway.
func safeEventID(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > 64 {
		return false
	}
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z',
			char >= 'A' && char <= 'Z',
			char >= '0' && char <= '9':
		case strings.ContainsRune("-.!%*_+`'~", char):
		default:
			return false
		}
	}
	return true
}

// acceptable reports whether a subscriber will take the body type we would send.
//
// An ABSENT Accept header means yes: RFC 6665 §4.2.1 says the notifier assumes the event package's
// default body type, which is exactly the one we send. Several handsets omit it, so treating absence
// as a refusal would answer 406 to phones that work.
func acceptable(accept, contentType string) bool {
	raw := strings.TrimSpace(accept)
	if raw == "" {
		return true
	}
	for _, entry := range strings.Split(raw, ",") {
		// Strip any q-value or other parameter before comparing.
		media, _, _ := strings.Cut(entry, ";")
		media = strings.ToLower(strings.TrimSpace(media))
		if media == "*/*" || media == contentType {
			return true
		}
		// `application/*` and friends.
		if prefix, _, found := strings.Cut(media, "/"); found && strings.HasSuffix(media, "/*") {
			if strings.HasPrefix(contentType, prefix+"/") {
				return true
			}
		}
	}
	return false
}

// addressOfRecord normalises a URI into an AOR and its user part.
//
// The host is lower-cased (case-insensitive per RFC 3261 §19.1.4) so the AOR — and therefore the
// subject token and the KV key — is stable no matter how the device spelled the domain.
func addressOfRecord(uri sip.Uri) (aor string, user string, ok bool) {
	if uri.User == "" || uri.Host == "" {
		return "", "", false
	}
	scheme := uri.Scheme
	if scheme == "" {
		scheme = "sip"
	}
	return scheme + ":" + uri.User + "@" + strings.ToLower(uri.Host), uri.User, true
}

func headerValue(req *sip.Request, name string) string {
	header := req.GetHeader(name)
	if header == nil {
		return ""
	}
	return header.Value()
}

// expiresHeader reads the request-level Expires header. sipgo's default parser leaves it generic, so
// it arrives as a string.
//
// A SUBSCRIBE states its interval THERE and not on a Contact parameter, unlike a REGISTER: there is
// one subscription per request, so there is nothing for a per-contact interval to disambiguate.
func expiresHeader(req *sip.Request) (time.Duration, bool) {
	raw := strings.TrimSpace(headerValue(req, "Expires"))
	if raw == "" {
		return 0, false
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds < 0 {
		return 0, false
	}
	return time.Duration(seconds) * time.Second, true
}

// fromTag returns the From header's tag parameter, or "".
func fromTag(from *sip.FromHeader) string {
	if from == nil {
		return ""
	}
	tag, _ := from.Params.Get("tag")
	return tag
}

// toTag returns the To header's tag parameter, or "".
//
// Its ABSENCE is what distinguishes an initial SUBSCRIBE from a refresh: a request with no To tag is
// establishing the dialog, so this edge mints the tag; one that carries a tag is already inside a
// dialog and must keep the one it was given.
func toTag(to *sip.ToHeader) string {
	if to == nil {
		return ""
	}
	tag, _ := to.Params.Get("tag")
	return tag
}
