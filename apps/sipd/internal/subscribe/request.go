package subscribe

import (
	"strconv"
	"strings"
	"time"

	"github.com/emiago/sipgo/sip"
)

// parseEvent splits an `Event` header into its package and its `id` parameter.
//
//	Event: dialog;id=1234
//
// RFC 6665 §8.2.1 makes the id part of the subscription's identity, so one phone can watch two
// extensions over one dialog and every notification must echo the id it belongs to.
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
	// The id is echoed into a header, so anything that could break or forge one is dropped rather
	// than echoed (CRLF injection); it is the only device-controlled string this package emits there.
	if !safeEventID(id) {
		id = ""
	}
	return EventPackage(name), id, true
}

// safeEventID reports whether an Event `id` may be echoed into a header: RFC 3261's `token`
// production, which is all the grammar allows there anyway.
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
// An absent Accept header means yes: RFC 6665 §4.2.1 has the notifier assume the event package's
// default body type, which is the one we send, and several handsets omit the header.
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
// Unlike REGISTER, a SUBSCRIBE states its interval there and not on a Contact parameter: there is
// one subscription per request.
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
// Its absence distinguishes an initial SUBSCRIBE from a refresh: no To tag means this edge mints
// one; a request carrying a tag is already in a dialog and must keep the tag it was given.
func toTag(to *sip.ToHeader) string {
	if to == nil {
		return ""
	}
	tag, _ := to.Params.Get("tag")
	return tag
}
