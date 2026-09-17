package registrar

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/emiago/sipgo/sip"
	location "github.com/optimiqs/optimiq-voice/apps/sipd/internal/aor"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

var errStaleRegistration = errors.New("REGISTER CSeq did not increase")
var errContactLimit = errors.New("registration contact limit exceeded")

func (r *Registrar) updateRegistration(ctx context.Context, req *sip.Request, tx sip.ServerTransaction,
	credential credentials.Credential, aor, hash string, headers []sip.Header, log *requestLog) {
	now := r.now()
	contactLimit := r.maxContacts
	if credential.MaxRegistrations > 0 {
		contactLimit = min(contactLimit, credential.MaxRegistrations)
	}
	headerExpiry, headerStated := expiresHeader(req)
	if req.GetHeader("Expires") != nil && !headerStated {
		r.respond(tx, req, 400, "Bad Request")
		return
	}
	changes := make([]location.Contact, 0, len(headers))
	wildcard := false
	for _, header := range headers {
		contact, ok := header.(*sip.ContactHeader)
		if !ok {
			r.respond(tx, req, 400, "Bad Request")
			return
		}
		if contact.Address.Wildcard {
			if len(headers) != 1 || !headerStated || headerExpiry != 0 {
				r.respond(tx, req, 400, "Bad Request")
				return
			}
			wildcard = true
			break
		}
		if contact.Address.Host == "" {
			r.respond(tx, req, 400, "Bad Request")
			return
		}
		if raw, stated := contact.Params.Get("expires"); stated {
			if value, err := strconv.ParseUint(raw, 10, 32); err != nil || value > uint64((1<<63-1)/int64(time.Second)) {
				r.respond(tx, req, 400, "Bad Request")
				return
			}
		}
		requested, stated := contactExpires(contact, headerExpiry, headerStated)
		granted, err := r.expiry.Grant(requested, stated)
		granted = r.clampGranted(req, granted)
		if errors.Is(err, ErrIntervalTooBrief) {
			res := sip.NewResponseFromRequest(req, statusIntervalTooBrief, "Interval Too Brief", nil)
			res.AppendHeader(sip.NewHeader("Min-Expires", strconv.Itoa(r.expiry.MinSeconds())))
			r.send(tx, res)
			return
		}
		if err != nil {
			r.respond(tx, req, 400, "Bad Request")
			return
		}
		changes = append(changes, location.Contact{
			URI: contact.Address.String(), Transport: string(transportOf(req)), SourceAddress: req.Source(),
			UserAgent: headerValue(req, "User-Agent"), DeviceID: credential.DeviceID,
			SIPDInstanceID: r.instanceID, Instance: location.ParseInstance(contact), RegID: location.ParseRegID(contact),
			Q: location.ParseQ(contact), CallID: headerValue(req, "Call-ID"), CSeq: cseqOf(req),
			SharedLineNumber: credential.SharedLineNumber, AppearanceIndex: credential.AppearanceIndex,
			RegisteredAt: now, ExpiresAt: now.Add(granted),
		})
	}
	before, after, err := r.bindings.Update(ctx, credential.OrgID, hash, func(previous *kv.Binding) (*kv.Binding, error) {
		binding := kv.Binding{OrgID: credential.OrgID, AOR: aor, AORHash: hash, ExtensionID: credential.ExtensionID}
		if previous != nil {
			binding = *previous
		}
		live, _ := location.FromBinding(binding).Expire(now)
		if wildcard {
			for _, existing := range live.Contacts() {
				if existing.CallID == headerValue(req, "Call-ID") && cseqOf(req) <= existing.CSeq {
					return nil, errStaleRegistration
				}
			}
			return nil, nil
		}
		for _, change := range changes {
			for _, existing := range live.Contacts() {
				if existing.Key() == change.Key() && existing.CallID == change.CallID && change.CSeq <= existing.CSeq {
					return nil, errStaleRegistration
				}
			}
			if change.Expired(now) {
				live, _ = live.Unbind(change.Key(), now)
				continue
			}
			outcome := live.Bind(change, contactLimit, now)
			if outcome.Refused {
				return nil, errContactLimit
			}
			live = outcome.Set
		}
		return bindingForSet(binding, live, now), nil
	})
	if err != nil {
		log.Warn("registration update refused", "error", err)
		if errors.Is(err, errContactLimit) {
			r.respond(tx, req, 403, "Too Many Contacts")
			return
		}
		r.respond(tx, req, 500, "Server Internal Error")
		return
	}
	r.trackChange(credential.OrgID, hash, before, after)
	identity := kv.Binding{OrgID: credential.OrgID, AOR: aor, AORHash: hash, ExtensionID: credential.ExtensionID}
	for _, removed := range removedContacts(before, after) {
		r.publishRemoved(ctx, identity, removed, removed.Expired(now))
	}
	if after == nil {
		r.respond(tx, req, 200, "OK")
		return
	}
	for _, change := range changes {
		if change.Expired(now) {
			continue
		}
		for _, contact := range location.FromBinding(*after).Contacts() {
			if contact.Key() != change.Key() {
				continue
			}
			refreshed := false
			if before != nil {
				for _, old := range location.FromBinding(*before).Contacts() {
					if old.Key() == contact.Key() && !old.Expired(now) {
						refreshed = true
					}
				}
			}
			r.publishRegistered(ctx, *after, contact, refreshed)
		}
	}
	r.send(tx, r.okWithBinding(req, *after))
}

func bindingForSet(binding kv.Binding, set location.Set, now time.Time) *kv.Binding {
	contacts := set.Contacts()
	if len(contacts) == 0 {
		return nil
	}
	binding = location.ApplyToBinding(binding, set)
	first, last := contacts[0].RegisteredAt, contacts[0].ExpiresAt
	for _, contact := range contacts {
		if contact.RegisteredAt.Before(first) {
			first = contact.RegisteredAt
		}
		if contact.ExpiresAt.After(last) {
			last = contact.ExpiresAt
		}
	}
	binding.RegisteredAt, binding.ExpiresAt = contract.NewEventTime(first), contract.NewEventTime(last)
	binding.ExpiresInSeconds = int((last.Sub(now) + time.Second - 1) / time.Second)
	return &binding
}

func removedContacts(before, after *kv.Binding) []location.Contact {
	if before == nil {
		return nil
	}
	live := make(map[string]bool)
	if after != nil {
		for _, contact := range location.FromBinding(*after).Contacts() {
			live[contact.Key()] = true
		}
	}
	var removed []location.Contact
	for _, contact := range location.FromBinding(*before).Contacts() {
		if !live[contact.Key()] {
			removed = append(removed, contact)
		}
	}
	return removed
}

func (r *Registrar) trackChange(orgID, hash string, before, after *kv.Binding) {
	key, err := contract.RegistrationKVKey(orgID, hash)
	if err != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	current, found := r.tracked[key]
	if after != nil {
		if !found || current.Revision <= after.Revision {
			r.tracked[key] = *after
		}
	} else if !found || (before != nil && current.Revision <= before.Revision) {
		delete(r.tracked, key)
	}
}

func (r *Registrar) publishRegistered(ctx context.Context, binding kv.Binding, contact location.Contact, refreshed bool) {
	envelope, err := contract.NewRegistrationRegisteredEnvelope(contract.EnvelopeInput[contract.RegistrationRegisteredData]{
		OrgID: binding.OrgID, Source: r.source, At: r.now(), Data: contract.RegistrationRegisteredData{
			AOR: binding.AOR, Contact: contact.URI, Transport: contract.SIPTransport(contact.Transport),
			UserAgent: optional(contact.UserAgent), SourceAddress: optional(contact.SourceAddress),
			DeviceID: optional(contact.DeviceID), ExtensionID: optional(binding.ExtensionID),
			ExpiresInSeconds: int((contact.ExpiresAt.Sub(r.now()) + time.Second - 1) / time.Second), Refreshed: &refreshed,
		},
	})
	if err == nil {
		err = r.publisher.Registered(ctx, envelope)
	}
	if err != nil {
		r.log.Error("cannot publish registered event", "error", err)
	}
}

func (r *Registrar) publishRemoved(ctx context.Context, binding kv.Binding, contact location.Contact, expired bool) {
	var err error
	if expired {
		seconds := max(0, int(r.now().Sub(contact.RegisteredAt)/time.Second))
		var envelope contract.Envelope[contract.RegistrationExpiredData]
		envelope, err = contract.NewRegistrationExpiredEnvelope(contract.EnvelopeInput[contract.RegistrationExpiredData]{
			OrgID: binding.OrgID, Source: r.source, At: r.now(), Data: contract.RegistrationExpiredData{
				AOR: binding.AOR, Contact: contact.URI, Transport: contract.SIPTransport(contact.Transport),
				UserAgent: optional(contact.UserAgent), SourceAddress: optional(contact.SourceAddress), DeviceID: optional(contact.DeviceID),
				ExtensionID: optional(binding.ExtensionID), RegisteredForSeconds: &seconds,
			},
		})
		if err == nil {
			err = r.publisher.Expired(ctx, envelope)
		}
	} else {
		reason := contract.RegistrationUnregisteredReasonClient
		var envelope contract.Envelope[contract.RegistrationUnregisteredData]
		envelope, err = contract.NewRegistrationUnregisteredEnvelope(contract.EnvelopeInput[contract.RegistrationUnregisteredData]{
			OrgID: binding.OrgID, Source: r.source, At: r.now(), Data: contract.RegistrationUnregisteredData{
				AOR: binding.AOR, Contact: contact.URI, Transport: contract.SIPTransport(contact.Transport),
				UserAgent: optional(contact.UserAgent), SourceAddress: optional(contact.SourceAddress), DeviceID: optional(contact.DeviceID),
				ExtensionID: optional(binding.ExtensionID), Reason: &reason,
			},
		})
		if err == nil {
			err = r.publisher.Unregistered(ctx, envelope)
		}
	}
	if err != nil {
		r.log.Error("cannot publish registration removal", "error", err)
	}
}
