package control

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
)

// RoutingTimeout bounds one ownership lookup plus, when the resource lives elsewhere, the forwarded
// request. Matched to the engine's ENGINE_MEDIAD_RPC_TIMEOUT_MS default so mediad never waits for a
// reply its caller has already abandoned.
const RoutingTimeout = 500 * time.Millisecond

// ownershipRouter keeps media RPCs on the node that owns their sockets. Only initial call placement
// uses the queue group; later requests are forwarded once to an addressed node.
type ownershipRouter struct {
	store   directory.Owners
	mu      sync.Mutex
	tracked map[string]map[string]struct{}
	// forwards bounds the requests being relayed to other instances at once. A forward waits on a
	// neighbour for up to RoutingTimeout, and it runs off the subscription's dispatcher goroutine
	// so that one wedged neighbour cannot hold up every other request on the same subject.
	forwards chan struct{}
}

// maxConcurrentForwards is the ceiling on relayed requests. Past it a request is refused as
// wrong_instance rather than queued: the engine's own deadline is one RoutingTimeout away.
const maxConcurrentForwards = 64

type resourceRequest struct {
	SessionID       string   `json:"sessionId"`
	SessionIDs      []string `json:"sessionIds"`
	OrgID           string   `json:"orgId"`
	CallID          string   `json:"callId"`
	BridgeID        string   `json:"bridgeId"`
	PlaybackRef     string   `json:"playbackRef"`
	RecordingRef    string   `json:"recordingRef"`
	TapID           string   `json:"tapId"`
	TargetSessionID string   `json:"targetSessionId"`
	TapSessionID    string   `json:"tapSessionId"`
}

func mediaInstanceSubject(subject, instance string) string {
	token, _ := contract.InstanceSubjectToken(instance)
	return subject + ".instance." + token
}

func (r resourceRequest) sessions() []string {
	ids := slices.Clone(r.SessionIDs)
	for _, id := range []string{r.SessionID, r.TargetSessionID, r.TapSessionID} {
		if id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

// orderingKey names the CONVERSATION a request touches, so the command runner keeps commands on one
// call in arrival order while letting different calls run at once.
//
// The key is one representative id — the lowest a request names — not the whole set. Joining the set
// gave `{a,b}` and `{a}` different keys, so `bridge(a,b)` and `release(a)` chained on nothing and ran
// together; a request naming a superset of another's sessions must land on the same chain as it.
// Ordering, not safety: every Manager operation is atomic under its own lock, and reordering two
// commands on unrelated calls is indistinguishable from them arriving in the other order.
//
// A request naming no session falls back to the resource it names; see Server.orderingKeyFor, which
// resolves that back to the session holding it.
func (r resourceRequest) orderingKey() string {
	ids := r.sessions()
	if len(ids) == 0 {
		return r.resourceKey()
	}
	return slices.Min(ids)
}

// orderingKeyFor is orderingKey with the router's own resource index consulted, so a command that
// carries only a reference — `stop-playback`, `stop-recording`, `unbridge`, `untap` — chains behind
// the command that started it rather than running beside it under a key of its own.
//
// The index is what routeRequest already records on every successful command: the sessions seen
// under a resource key. A reference this instance has never served falls back to the resource key,
// which is still stable for repeats of that same reference.
func (s *Server) orderingKeyFor(request resourceRequest) string {
	key := request.orderingKey()
	if s.ownership == nil || len(request.sessions()) > 0 || key == "" {
		return key
	}
	s.ownership.mu.Lock()
	defer s.ownership.mu.Unlock()
	owner := ""
	for id := range s.ownership.tracked[key] {
		if owner == "" || id < owner {
			owner = id
		}
	}
	if owner == "" {
		return key
	}
	return owner
}

func (r resourceRequest) resourceKey() string {
	for _, item := range []struct{ kind, id string }{
		{"bridge", r.BridgeID}, {"playback", r.PlaybackRef},
		{"recording", r.RecordingRef}, {"tap", r.TapID},
	} {
		if item.id != "" {
			return directory.OwnerKey(item.kind, item.id)
		}
	}
	return ""
}

// routeRequest answers a request. It runs on a keyedRunner goroutine, never on the subscription
// dispatcher: both halves below block on the broker, so answering inline serialised every request on
// the subject behind the KV round trips of the one in front.
func (s *Server) routeRequest(conn *nats.Conn, subject string, data []byte, request resourceRequest, handle func([]byte) []byte, addressed bool) []byte {
	if s.ownership == nil {
		return handle(data)
	}
	// Bounded by the engine's own RPC budget: past it the reply lands on a caller that has given
	// up, while the goroutine issuing it stays parked.
	ctx, cancel := context.WithTimeout(context.Background(), RoutingTimeout)
	defer cancel()
	owner, keys, err := s.requestOwner(ctx, subject, request)
	if err != nil {
		return s.routingFailure(request, ReasonInternal, err)
	}
	if owner != "" && owner != s.instanceID {
		if addressed {
			return s.routingFailure(request, ReasonWrongNode,
				errors.New("addressed media owner no longer owns the resource"))
		}
		select {
		case s.ownership.forwards <- struct{}{}:
		default:
			return s.routingFailure(request, ReasonWrongNode,
				errors.New("too many media requests are already being relayed"))
		}
		defer func() { <-s.ownership.forwards }()
		relayed, err := conn.RequestWithContext(ctx, mediaInstanceSubject(subject, owner), data)
		if err != nil {
			// wrong_instance, not internal: the session is alive on a named neighbour, which is
			// the code the engine branches on to re-address it there.
			return s.routingFailure(request, ReasonWrongNode,
				errors.New("owning media instance is unavailable"))
		}
		return relayed.Data
	}
	result := handle(data)
	var response struct {
		Ok bool `json:"ok"`
	}
	if json.Unmarshal(result, &response) == nil && response.Ok {
		s.ownership.mu.Lock()
		for _, key := range keys {
			if s.ownership.tracked[key] == nil {
				s.ownership.tracked[key] = make(map[string]struct{})
			}
			for _, id := range request.sessions() {
				s.ownership.tracked[key][id] = struct{}{}
			}
		}
		s.ownership.mu.Unlock()
	}
	return result
}

func (s *Server) requestOwner(ctx context.Context, subject string, request resourceRequest) (string, []string, error) {
	store := s.ownership.store
	owner := ""
	keys := make([]string, 0, 4)
	setOwner := func(found string) error {
		if found == "" {
			return nil
		}
		if owner != "" && owner != found {
			return errors.New("media resources live on different instances; relocation is required")
		}
		owner = found
		return nil
	}
	for _, id := range request.sessions() {
		key := directory.OwnerKey("session", id)
		if s.ownsLocally(key, id) {
			keys = append(keys, key)
			if err := setOwner(s.instanceID); err != nil {
				return "", nil, err
			}
			continue
		}
		found, err := store.Get(ctx, key)
		if err != nil {
			return "", nil, err
		}
		if found == "" {
			// Sessions predating ownership routing have no owner key; the directory still locates them.
			entry, exists, err := s.dir.Get(ctx, id)
			if err != nil {
				return "", nil, err
			}
			if exists {
				found = entry.InstanceID
			}
		}
		if err := setOwner(found); err != nil {
			return "", nil, err
		}
		keys = append(keys, key)
	}
	allocate := subject == SubjectAllocateSession || subject == SubjectCreateOffer
	if allocate && request.OrgID != "" && request.CallID != "" && request.SessionID != "" {
		key := directory.OwnerKey("call", request.OrgID+"\x00"+request.CallID)
		found, err := store.Claim(ctx, key, cmp.Or(owner, s.instanceID))
		if err != nil {
			return "", nil, err
		}
		if err := setOwner(found); err != nil {
			return "", nil, err
		}
		keys = append(keys, key)
		found, err = store.Claim(ctx, directory.OwnerKey("session", request.SessionID), owner)
		if err != nil {
			return "", nil, err
		}
		if err := setOwner(found); err != nil {
			return "", nil, err
		}
	}
	if key := request.resourceKey(); key != "" {
		found, err := store.Get(ctx, key)
		if err != nil {
			return "", nil, err
		}
		if err := setOwner(found); err != nil {
			return "", nil, err
		}
		if owner != "" {
			found, err = store.Claim(ctx, key, owner)
			if err != nil {
				return "", nil, err
			}
			if err := setOwner(found); err != nil {
				return "", nil, err
			}
		}
		keys = append(keys, key)
	}
	return owner, keys, nil
}

// ownsLocally reports whether this instance has claimed key AND still holds sessionID. Both halves
// are required: the tracked map is only pruned once a minute, and a session can be live here
// without this instance having won the claim.
func (s *Server) ownsLocally(key, sessionID string) bool {
	if sessionID == "" {
		return false
	}
	s.ownership.mu.Lock()
	_, tracked := s.ownership.tracked[key][sessionID]
	s.ownership.mu.Unlock()
	if !tracked {
		return false
	}
	_, _, live := s.sessions.SessionTenancy(sessionID)
	return live
}

// routingFailure carries every media response's identity fields so callers parse it as a normal refusal.
// The sessionIds copy stays an append onto an empty slice, not slices.Clone: a nil clone would
// marshal as null where every other refusal sends [].
func (s *Server) routingFailure(request resourceRequest, reason string, err error) []byte {
	return encode(s.log, map[string]any{
		"ok": false, "reason": reason, "error": fmt.Sprint(err), "instanceId": s.instanceID,
		"sessionId": request.SessionID, "sessionIds": append([]string{}, request.SessionIDs...), "bridgeId": request.BridgeID,
		"released": false, "stopped": false, "unbridged": false, "untapped": false,
		"playbackRef": request.PlaybackRef, "recordingRef": request.RecordingRef, "tapId": request.TapID,
	})
}

// RenewOwnership keeps long calls addressable, renewing only keys attached to a live local RTP
// session so completed operations and crashed instances age out. Runs until ctx is done.
func (s *Server) RenewOwnership(ctx context.Context) {
	if s.ownership == nil {
		return
	}
	timer := time.NewTicker(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.ownership.mu.Lock()
			keys := make([]string, 0, len(s.ownership.tracked))
			for key, sessions := range s.ownership.tracked {
				maps.DeleteFunc(sessions, func(id string, _ struct{}) bool {
					_, _, exists := s.sessions.SessionTenancy(id)
					return !exists
				})
				if len(sessions) == 0 {
					delete(s.ownership.tracked, key)
				} else {
					keys = append(keys, key)
				}
			}
			s.ownership.mu.Unlock()
			for _, key := range keys {
				updateCtx, cancel := context.WithTimeout(ctx, directory.Timeout)
				err := s.ownership.store.Refresh(updateCtx, key, s.instanceID)
				cancel()
				if err != nil && !errors.Is(err, context.Canceled) {
					s.log.Warn("cannot renew media ownership", "error", err)
				}
			}
		}
	}
}
