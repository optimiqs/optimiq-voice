/**
 * The words the SIP security screens put on the closed sets in `contracts.ts`.
 *
 * Separated from the components for the reason `lib/cdr/format.ts` is: a scope appears in a table
 * cell, in a filter option and in a form's radio list, and three copies of "Phone registration"
 * become three slightly different sentences the first time one is edited. The sets themselves stay
 * in `contracts.ts` — this file only names them.
 *
 * ## The descriptions are load-bearing, not decoration
 *
 * `scope` has no default on the form, deliberately (`sip-acl.dto.ts`: "a caller that omitted the
 * scope almost certainly did not mean the one that governs whether phones can register"). A choice
 * with no default is only a real choice if the options explain themselves, so each one says what it
 * actually gates — including which of them reach the media server and which are read straight from
 * the database.
 */

import type { SipAclScope, SipAuthEventType } from "./contracts";
import type { BadgeProps } from "~/components/ui/badge";

export const SIP_ACL_SCOPE_LABELS: Readonly<Record<SipAclScope, string>> = {
	registration: "Phone registration",
	trunk: "Trunk signalling",
	provisioning: "Device provisioning",
	api: "API access",
};

export const SIP_ACL_SCOPE_DESCRIPTIONS: Readonly<Record<SipAclScope, string>> = {
	registration:
		"Which networks a handset may REGISTER from. Rendered into the media server's access configuration, so a change needs a regenerate and a transport reload.",
	trunk:
		"Which networks may send call signalling to this platform. Also rendered into the media server's access configuration — get this wrong and a carrier stops being able to deliver calls.",
	provisioning:
		"Which networks may fetch a device's provisioning file. Read straight from the database on every request, so a change applies immediately.",
	api: "Which networks may reach the HTTP API. Read from the database, so a change applies immediately.",
};

/**
 * Why an attempt was refused — the REASON, never the surface. The surface is the scope.
 *
 * `unknown-account` and `disabled-account` stay apart because they mean opposite things to whoever
 * is reading: the first is somebody guessing at account names, the second is a credential that
 * outlived its authorisation. Folding them together would hide the one an administrator can act on
 * today.
 */
export const SIP_AUTH_EVENT_TYPE_LABELS: Readonly<Record<SipAuthEventType, string>> = {
	"acl-denied": "Blocked by a rule",
	"rate-limited": "Rate limited",
	"unknown-account": "No such account",
	"bad-credentials": "Wrong credentials",
	"token-invalid": "Invalid token",
	"token-expired": "Expired token",
	"disabled-account": "Account disabled",
};

/**
 * How loudly each refusal reads.
 *
 * Only two tones, and the split is "somebody is probing" against "something of ours is
 * misconfigured or has lapsed". A palette with a colour per event type would turn a table into a
 * legend nobody learns; two tones answer the question a reader actually has, which is whether the
 * row is an attack or a mistake.
 *
 * `acl-denied` is the deliberate ambiguity and it is filed as a warning rather than a danger: the
 * commonest cause is a legitimate office whose address changed, which is a rule to fix rather than
 * an attack to escalate.
 */
export const SIP_AUTH_EVENT_TYPE_TONES: Readonly<Record<SipAuthEventType, BadgeProps["tone"]>> = {
	"acl-denied": "warning",
	"rate-limited": "danger",
	"unknown-account": "danger",
	"bad-credentials": "danger",
	"token-invalid": "danger",
	"token-expired": "warning",
	"disabled-account": "warning",
};
