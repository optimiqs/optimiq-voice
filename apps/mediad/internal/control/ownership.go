package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
)

// ownershipRouter keeps raw media RPCs on the node that owns their sockets. Only initial call
// placement uses a queue group. Subsequent requests are forwarded once to an addressed node.
type ownershipRouter struct {
	store   directory.Owners
	mu      sync.Mutex
	tracked map[string]map[string]struct{}
}

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
	ids := append([]string{}, r.SessionIDs...)
	for _, id := range []string{r.SessionID, r.TargetSessionID, r.TapSessionID} {
		if id != "" {
			ids = append(ids, id)
		}
	}
	return ids
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

func (s *Server) routeRequest(conn *nats.Conn, subject string, data []byte, handle func([]byte) []byte, addressed bool) []byte {
	if s.ownership == nil {
		return handle(data)
	}
	var request resourceRequest
	if json.Unmarshal(data, &request) != nil {
		return handle(data)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	owner, keys, err := s.requestOwner(ctx, subject, request)
	if err != nil {
		// A KV failure, which really is this node's problem. Kept as `internal`.
		return s.routingFailure(request, ReasonInternal, err)
	}
	if owner != "" && owner != s.instanceID {
		if addressed {
			return s.routingFailure(request, ReasonWrongNode,
				errors.New("addressed media owner no longer owns the resource"))
		}
		reply, err := conn.RequestWithContext(ctx, mediaInstanceSubject(subject, owner), data)
		if err != nil {
			// `wrong_instance`, not `internal`: the session is alive on a NAMED neighbour, and that is
			// the code the engine branches on to address it there. `internal` invited a retry on this
			// node that would fail identically.
			return s.routingFailure(request, ReasonWrongNode,
				errors.New("owning media instance is unavailable"))
		}
		return reply.Data
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
			// Answered from memory. Ownership is immutable once claimed, so a key this instance has
			// already claimed FOR A SESSION IT STILL HAS is a broker round trip with a known answer
			// — and this runs on `bridge-sessions` and `start-playback`, which have a 500 ms budget
			// that two or three of those round trips were eating into.
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
			// Existing sessions from before ownership routing was enabled remain addressable.
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
		candidate := owner
		if candidate == "" {
			candidate = s.instanceID
		}
		found, err := store.Claim(ctx, key, candidate)
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

// owns reports whether this instance has already claimed key for a session it still holds.
//
// BOTH halves are load-bearing. The tracked map alone goes stale — it is pruned once a minute — and
// answering from it for a session that has since been released would route the command here to be
// refused as unknown rather than to the instance that has it. The live-session check alone is not
// enough either: a session can be live here without this instance having won the claim.
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

func (s *Server) routingFailure(request resourceRequest, reason string, err error) []byte {
	// Match every media response's identity fields; callers retain their normal refusal parsing.
	return encode(s.log, map[string]any{
		"ok": false, "reason": reason, "error": fmt.Sprint(err), "instanceId": s.instanceID,
		"sessionId": request.SessionID, "sessionIds": append([]string{}, request.SessionIDs...), "bridgeId": request.BridgeID,
		"released": false, "stopped": false, "unbridged": false, "untapped": false,
		"playbackRef": request.PlaybackRef, "recordingRef": request.RecordingRef, "tapId": request.TapID,
	})
}

// RenewOwnership keeps long calls addressable. Only keys attached to a live local RTP session
// are renewed; completed and failed operations age out, including after an instance crash.
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
				for id := range sessions {
					if _, _, exists := s.sessions.SessionTenancy(id); !exists {
						delete(sessions, id)
					}
				}
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
