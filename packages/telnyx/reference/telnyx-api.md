# Telnyx API v2 — the surface this package is pinned to

**Researched 2026-08-06.** Every field name, enum member and status code below was read from
Telnyx's consolidated OpenAPI 3.1.0 document and, where noted, cross-checked against the live API.
This file is the contract: when `TelnyxResponseShapeError` fires, the fix is to re-read the source
listed for that section and update both the schema and this document in the same change.

**Canonical machine-readable source (prefer it over the HTML docs, which are stale in several
places noted below):**
<https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json>

---

## Authentication and versioning

<https://developers.telnyx.com/development/api-fundamentals/authentication/index>

- Base URL `https://api.telnyx.com/v2`.
- `Authorization: Bearer <API key>`.
- Versioning is **path-only**. There is no `Telnyx-Version` header; do not send one.
- The key is a **platform** credential (decision D5). It is never sent to a browser and never
  scoped per tenant.

---

## Number search — `GET /v2/available_phone_numbers`

<https://developers.telnyx.com/api-reference/numbers/list-available-phone-numbers>

Filters are one `filter` parameter serialized `deepObject`/`explode`, i.e. `filter[key]=value`.

| Parameter                           | Values                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `filter[country_code]`              | ISO-3166 alpha-2                                                                     |
| `filter[national_destination_code]` | area code                                                                            |
| `filter[phone_number][contains]`    | also `[starts_with]`, `[ends_with]`                                                  |
| `filter[locality]`                  | city                                                                                 |
| `filter[administrative_area]`       | state/province                                                                       |
| `filter[rate_center]`               | US/CA only                                                                           |
| **`filter[phone_number_type]`**     | `local` · `toll_free` · `mobile` · `national` · `shared_cost`                        |
| `filter[features]`                  | `sms` `mms` `voice` `fax` `emergency` `hd_voice` `international_sms` `local_calling` |
| `filter[limit]`                     | integer                                                                              |
| `filter[best_effort]`               | boolean, US/CA only                                                                  |
| `filter[quickship]`                 | boolean, +1 toll-free only                                                           |
| `filter[reservable]`                | boolean                                                                              |
| `filter[exclude_held_numbers]`      | boolean                                                                              |

> **Trap.** It is `filter[phone_number_type]` here but `filter[number_type][eq]` on
> `GET /v2/phone_numbers`. The two endpoints genuinely differ.

Response:

```jsonc
{
  "data": [{
    "record_type": "available_phone_number",
    "phone_number": "+19705555098",
    "vanity_format": "",
    "best_effort": false,
    "quickship": true,
    "reservable": true,
    "region_information": [{ "region_type": "country_code" | "rate_center" | "state" | "location",
                             "region_name": "US" }],
    "cost_information": { "upfront_cost": "3.21", "monthly_cost": "6.54", "currency": "USD" },
    "features": [{ "name": "voice" }]
  }],
  "meta":     { "total_results": 1, "best_effort_results": 0 },
  "metadata": { "total_results": 1, "best_effort_results": 0 }
}
```

> **Traps.** `features[]` is an array of **objects**, not strings. Costs are **strings**. The
> envelope carries both `meta` and `metadata` (legacy duplication) — treat both as optional.

---

## Number orders — `POST /v2/number_orders`, `GET /v2/number_orders/{number_order_id}`

<https://developers.telnyx.com/api-reference/numbers/create-a-number-order> ·
<https://developers.telnyx.com/api-reference/numbers/retrieve-a-number-order>

`POST` returns **200**, not 201. The `GET` response is the identical schema, so one parser serves
both. The path parameter is `number_order_id`.

Request: `phone_numbers[{phone_number, requirement_group_id?, bundle_id?}]` (required),
`connection_id?`, `messaging_profile_id?`, `billing_group_id?`, `customer_reference?`.

Response `data`: `id`, `record_type: "number_order"`, `phone_numbers_count`, `connection_id`,
`messaging_profile_id`, `billing_group_id`, `customer_reference`, `requirements_met`,
`sub_number_orders_ids[]`, `status`, `created_at`, `updated_at`, and
`phone_numbers[{id, record_type, phone_number, country_code, country_iso_alpha2, bundle_id,
phone_number_type, regulatory_requirements[], requirements_met, requirements_status, status}]`.

- **`status`: `pending` · `success` · `failure`** — three values, at both order and per-number level.
- `requirements_status` is a **separate** seven-value enum: `pending` · `approved` · `cancelled` ·
  `deleted` · `requirement-info-exception` · `requirement-info-pending` ·
  `requirement-info-under-review`.

**Ordering constraint.** Error `85000` — _"You must search for the number through our API before
attempting to purchase."_ An arbitrary E.164 cannot be ordered; a search must precede the order.

List filters include `filter[customer_reference]`, which is the reconciliation path this package
relies on in the absence of idempotency (below).

---

## Phone numbers — `GET|PATCH|DELETE /v2/phone_numbers[/{id}]`

<https://developers.telnyx.com/api-reference/numbers/list-phone-numbers> ·
<https://developers.telnyx.com/api-reference/numbers/update-a-phone-number>

- `PATCH` body accepts `connection_id`, `tags[]`, `customer_reference`, `external_pin`,
  `billing_group_id`, `hd_voice_enabled`, `address_id`.
- **`DELETE` returns 200 with the full phone-number object**, not 204. This is the release call.
- `status` on `GET`/`PATCH`/`DELETE` of a single number is a 13-value enum: `purchase-pending`,
  `purchase-failed`, `port-pending`, `port-failed`, `active`, `deleted`, `emergency-only`,
  `ported-out`, `port-out-pending`, `requirement-info-pending`, `requirement-info-under-review`,
  `requirement-info-exception`, `provision-pending`.
- `phone_number_type` here also carries legacy members for pre-July-2023 numbers: `landline`,
  `tollfree`, `shortcode`, `longcode`.

### Voice settings — `GET|PATCH /v2/phone_numbers/{id}/voice`

<https://developers.telnyx.com/api-reference/numbers/retrieve-phone-number-voice-settings>

`GET` returns `id`, `record_type`, `phone_number`, `connection_id`, `customer_reference`,
`tech_prefix_enabled`, `translated_number`, `usage_payment_method` (`pay-per-minute` · `channel`),
`inbound_call_screening` (`disabled` · `reject_calls` · `flag_calls`), and the nested groups
`call_forwarding{call_forwarding_enabled, forwards_to, forwarding_type: always|on-failure}`,
`cnam_listing{cnam_listing_enabled, cnam_listing_details}`,
`emergency{emergency_enabled, emergency_address_id, emergency_status}`,
`media_features{rtp_auto_adjust_enabled, accept_any_rtp_packets_enabled, t38_fax_gateway_enabled}`,
`call_recording{inbound_call_recording_enabled, inbound_call_recording_format: wav|mp3,
inbound_call_recording_channels: single|dual}`.

> **Trap — GET and PATCH are asymmetric.** `caller_id_name_enabled` is accepted by `PATCH` but is
> **not returned** by `GET` (read it from `GET /v2/phone_numbers/{id}` instead). `PATCH` does not
> accept `connection_id`, `customer_reference` or `emergency`: set the connection with
> `PATCH /v2/phone_numbers/{id}`, and emergency with
> `POST /v2/phone_numbers/{id}/actions/enable_emergency`.

---

## Credential connections — `/v2/credential_connections`

<https://developers.telnyx.com/api-reference/credential-connections/create-a-credential-connection>

`POST` returns **201**; `GET`/`PATCH`/`DELETE` return 200. `PATCH` takes the same field set as
`POST` with nothing required. `POST` requires `connection_name`, `user_name`, `password`.

Credential constraints, enforced client-side because a rejection here costs a round trip on a
provisioning path a human is watching:

- `user_name` — 4–32 characters, **alphanumeric only**, and **at least one of the first five
  characters must be a letter** (the second rule appears on the response schema only, but is
  enforced by the API).
- `password` — 8–128 characters, no documented charset restriction.
- Uniqueness of `user_name` across Telnyx is **not documented** but is near-certain, since the
  username is the AoR under a shared registrar domain. Generate a long random username and treat a
  create-time collision as a retryable-with-new-username condition rather than assuming it away.

Enums used by this package:

- `anchorsite_override` (default `Latency`) — exactly ten values: `Latency`, `Chicago, IL`,
  `Ashburn, VA`, `San Jose, CA`, `Sydney, Australia`, `Amsterdam, Netherlands`, `London, UK`,
  `Toronto, Canada`, `Vancouver, Canada`, `Frankfurt, Germany`.
  **The anchorsite-configuration doc page lists eleven and shows a lowercase example; it is wrong**
  and those values are rejected.
- `dtmf_type` — `RFC 2833` (default) · `Inband` · `SIP INFO` (note the spaces).
- `encrypted_media` — `"SRTP"` or `null`.
- `sip_uri_calling_preference` — `disabled` · `unrestricted` · `internal`.
- `webhook_api_version` — `"1"` (default) · `"2"`; `"texml"` on request only.
- `inbound.ani_number_format` — `+E.164` · `E.164` · `+E.164-national` · `E.164-national` (default).
- `outbound.ani_override_type` — `always` · `normal` · `emergency`.

> **Fields that do NOT exist on credential connections:** `microsoft_teams_sbc` (FQDN connections
> only) and `transport_protocol` — Telnyx states the transport is chosen by the registering user
> agent and cannot be set server-side.

### SIP configuration a PBX needs

Canonical network reference: <https://sip.telnyx.com/> (machine-readable `voice.json`).

```
Registrar / outbound proxy : sip.telnyx.com
Ports                      : 5060/UDP, 5060/TCP, 5061/TLS
AoR                        : <user_name>@sip.telnyx.com
Register expiry            : ~180 s (Telnyx recommendation)
RTP                        : UDP 16384–32768
```

**Registration is required for INBOUND only.** Outbound needs no REGISTER: Telnyx challenges the
INVITE with a SIP `407` and the same digest credential answers it
(<https://support.telnyx.com/en/articles/4363904-sip-registration>).

Regional signalling FQDNs (DNS-verified 2026-08-06):

| Region      | FQDN                | Addresses                   |
| ----------- | ------------------- | --------------------------- |
| US          | `sip.telnyx.com`    | 192.76.120.10, 64.16.250.10 |
| Europe      | `sip.telnyx.eu`     | 185.246.41.140, .141        |
| Australia   | `sip.telnyx.com.au` | 103.115.244.145, .146       |
| Canada      | `sip.telnyx.ca`     | 192.76.120.31, 64.16.250.13 |
| Middle East | `sip.telnyx.me`     | 185.246.42.128, .129        |
| Asia (beta) | `sip.telnyx.asia`   | 103.115.244.158, .159       |

> Two Telnyx doc pages publish `sip-eu.telnyx.com` / `sip-ca.telnyx.com` / `sip-au.telnyx.com`.
> Those names do not resolve. There are no city-level signalling hostnames; city names appear only
> in `anchorsite_override`, which controls **media anchoring, not signalling**.

Health check: `POST /v2/credential_connections/{id}/actions/check_registration_status` →
`{record_type, status, sip_username, ip_address, transport, port, user_agent, last_registration}`
with `status` ∈ `Not Applicable` · `Not Registered` · `Failed` · `Expired` · `Registered` ·
`Unregistered`.

---

## Outbound voice profiles — `/v2/outbound_voice_profiles`

<https://developers.telnyx.com/api-reference/outbound-voice-profiles/create-an-outbound-voice-profile>

All methods return 200. `name` is required, minimum length 3.

Fields: `id`, `record_type`, `name`, `connections_count`, `traffic_type`, `service_plan`,
`concurrent_call_limit` (nullable), `enabled` (default true), `tags[]`, `usage_payment_method`,
`whitelisted_destinations[]` (**default `["US","CA"]`**), `max_destination_rate` (number),
`daily_spend_limit` (**string**), `daily_spend_limit_enabled`, `call_recording{…}`,
`billing_group_id`, `created_at`, `updated_at`.

**The three enums are single-valued in the current spec** — `traffic_type: "conversational"`,
`service_plan: "global"`, `usage_payment_method: "rate-deck"`. Modelled as literals so a future
addition fails loudly here rather than silently downstream.

---

## Programmable Fax — `POST /v2/faxes`, `GET /v2/faxes/{id}`

<https://developers.telnyx.com/api-reference/programmable-fax/send-fax>

Fax is routed at the **carrier edge**, not in the media plane: mediad has no T.38 gateway and no
CNG/CED tone detector (rung 8, absent — see `plans/parity-audit-2026-08-11.md` rows 2.27, 4.20), so
Telnyx receives the inbound fax and renders it to a document, and we hand Telnyx a document to send.

`POST /v2/faxes` — send. Body:

| Field               | Notes                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| `connection_id`     | **required** — a fax-enabled connection / Fax Application id                   |
| `to`, `from`        | **required** — E.164                                                           |
| `media_url`         | a URL to the source PDF or TIFF. **Exactly one** of `media_url` / `media_name` |
| `media_name`        | a name from the Media Storage API. Exactly one of the two                      |
| `from_display_name` | optional header text                                                           |
| `quality`           | `normal` (default) · `high` · `ultra`                                          |
| `monochrome`        | boolean, default false                                                         |
| `store_media`       | boolean, default false — keep the sent document for later retrieval            |
| `t38_enabled`       | boolean, default true                                                          |
| `webhook_url`       | per-fax override of the connection webhook                                     |
| `client_state`      | echoed verbatim on every `fax.*` webhook — our correlation token               |

> **Trap.** `POST /v2/faxes` returns **202 Accepted**, not 200/201 — the fax is _queued_, and the
> outcome arrives asynchronously over webhooks. `GET /v2/faxes/{id}` returns the identical `fax`
> object, so one schema serves both.

> **Trap.** There is **no `Idempotency-Key`** on this endpoint (§Idempotency), and no
> `customer_reference`/filter to reconcile by. So a send must be `retryable: false` — a retried send
> is a second fax — and reconciliation is by webhook keyed on `client_state`, or a `GET` on the id
> the 202 returned.

The `fax` object (send response and read):

```jsonc
{
	"data": {
		"record_type": "fax",
		"id": "<uuid>",
		"direction": "outbound", // or "inbound"
		"status": "queued", // queued → media.processed → originated → sending → delivered|failed
		"connection_id": "<uuid>",
		"from": "+13125550000",
		"to": "+13125551111",
		"quality": "normal",
		"media_url": "https://…/doc.pdf",
		"media_name": null,
		"original_media_url": "https://…/doc.pdf",
		"stored_media_url": null,
		"page_count": null,
		"store_media": false,
		"t38_enabled": true,
		"client_state": "<our fax_message row id>",
		"created_at": "…",
		"updated_at": "…",
	},
}
```

Statuses (object level): `queued` · `media.processed` · `originated` · `sending` · `delivered` ·
`failed` · `initiated` · `receiving` · `received`. Unknown members must not break a read.

Fax lifecycle is reported over webhooks (§Webhooks), not polled.

---

## Errors

<https://developers.telnyx.com/development/api-fundamentals/api-errors> ·
catalog: <https://developers.telnyx.com/data/api-errors.json>

```jsonc
{
	"errors": [
		{
			"code": "10009",
			"title": "Authentication failed",
			"detail": "Could not find any usable credentials in the request.",
			"source": { "pointer": "/" },
			"meta": { "url": "…" },
		},
	],
}
```

> **Trap.** `code` is a **string** on the wire (verified live) even though one of the spec's two
> conflicting definitions declares it an integer. This package coerces to string.

Codes this integration branches on or logs by name:

| Code    | Meaning                                                |
| ------- | ------------------------------------------------------ |
| `10009` | Authentication failed — our platform key is wrong      |
| `10010` | Authorization failed                                   |
| `10011` | Too many requests (the 429 body code)                  |
| `10015` | Bad request / invalid `Idempotency-Key`                |
| `10027` | Unprocessable entity                                   |
| `20012` | Account inactive                                       |
| `20100` | Insufficient funds                                     |
| `85000` | Must search the number through the API before ordering |
| `85001` | Phone numbers not available                            |
| `85004` | Invalid connection id provided                         |
| `85006` | The phone number is already reserved                   |
| `90042` | Outbound voice profile channel limit exceeded          |
| `90043` | Connection outbound channel limit exceeded             |

HTTP statuses in use: 200, 201, 202, 204, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504.

---

## Rate limiting

<https://developers.telnyx.com/development/api-fundamentals/reliability/rate-limiting>

No numeric limit is published. The live API returns both prefixed and unprefixed families:

```
x-ratelimit-limit: 2000, 2000;w=1
x-ratelimit-remaining: 1999
x-ratelimit-reset: 1
```

`2000, 2000;w=1` is the IETF draft form — roughly 2000 requests per one-second sliding window.
Empirical only; read the header at runtime rather than hardcoding.

> **`Retry-After` is not sent** — zero occurrences in the spec, absent from the docs' header table,
> not observed live. Telnyx instructs clients to use exponential backoff. `x-ratelimit-reset` is
> **seconds until reset, not a Unix epoch**; the doc example showing an epoch is wrong.

---

## Idempotency — the firm negative

`Idempotency-Key` exists on **exactly seven POST operations**, all email or storage:
`/email_messages`, `/email_messages/batch`, `/email_templates`, `/email_validations`,
`/email_validations/batch`, `/storage/cloudfs`, `/storage/cloudfs/{id}/actions/rotate-meta-token`.

**It is not supported on `/number_orders`, `/phone_numbers`, `/credential_connections` or
`/outbound_voice_profiles`.** Verified by enumerating every operation's parameter list in the spec.

Consequence, and the reason `retry.ts` has an opt-out: `POST /v2/number_orders` is **not safely
retryable**. This package therefore

1. sets `retryable: false` on order creation, so a timeout never silently becomes a second order;
2. stamps a caller-supplied `customer_reference` on every order, which is our own idempotency
   token; and
3. exposes `numberOrders.findByCustomerReference` so an ambiguous failure is _reconciled_ rather
   than retried.

Where Telnyx does honour the header, the contract is: `^[A-Za-z0-9_-]{1,255}$`, 409 while a request
with the same key is in flight, 422 on reuse with a different body, successful responses replayed
for 24 hours, replays marked `Idempotent-Replayed: true`.

---

## Webhooks

<https://developers.telnyx.com/development/api-fundamentals/webhooks/receiving-webhooks>

Headers (match **case-insensitively** — Telnyx's own pages disagree on case):

```
telnyx-signature-ed25519: <base64 signature, 64 raw bytes>
telnyx-timestamp:         <unix seconds>
```

Signed message is the timestamp, a pipe, and the **raw body**:

```
verify(base64decode(signature), utf8(`${timestamp}|${rawBody}`), base64decode(publicKey))
```

- The public key from <https://portal.telnyx.com/#/api-keys/public-key> is **base64 of the raw
  32-byte Ed25519 key**, not DER. Node needs the SPKI prefix `302a300506032b6570032100` prepended;
  `webhooks/signature.ts` does that.
- **Tolerance is the receiver's job.** Telnyx does not enforce it and recommends rejecting anything
  more than 5 minutes old.
- Rotation: `POST /v2/inactive_key`, `POST /v2/inactive_key/{id}/activate`; activation may take up
  to 60 minutes, so a receiver should tolerate two valid keys during a rotation window.

> **Trap.** Telnyx's own Node and Python samples sign `JSON.stringify(req.body)`, contradicting
> their troubleshooting note that says to use the raw body. The note is right. `apps/api` keeps the
> raw buffer for this route specifically.

Body, for `webhook_api_version: "2"`:

```jsonc
{
	"data": {
		"record_type": "event",
		"event_type": "number_order.complete",
		"id": "<uuid>",
		"occurred_at": "2026-08-06T16:23:54.496464Z",
		"payload": {/* the number order, as in §Number orders */},
	},
	"meta": { "attempt": 1, "delivered_to": "https://…/webhooks/telnyx" },
}
```

> **Traps.** This envelope holds **only** for `webhook_api_version: "2"`; version `"1"` — the
> **default** — uses a flat envelope with `metadata` and a nested `metadata.event`. This package
> sets `"2"` explicitly on every connection it creates.
>
> The only number-order event type is **`number_order.complete`**; there is no
> `number_order.status_update` (that is the OpenAPI _webhook key_, not the emitted string). It
> fires for both outcomes, so branch on `data.payload.status`.
>
> **There are no `phone_number.*` webhook events at all.** Number state changes are polled.

Delivery: respond 2xx within `webhook_timeout_secs` (0–30, default ~2 s). Order is not guaranteed
and duplicates are expected — dedupe on `data.id`. Source IPs `192.76.120.192/27`. Deliveries are
inspectable via `GET /v2/webhook_deliveries`.

---

## Connection types, and why this integration uses credential connections

<https://developers.telnyx.com/docs/voice/sip-trunking/authentication/credential-types>

Telnyx's own rule: credential connections for a **dynamic** public IP, IP connections for a
**static** one.

- **`credential_connections`** — SIP username/password, digest-authenticated: REGISTER (401
  challenge) for inbound, INVITE (407 challenge) for outbound. The registration binding is what
  tells Telnyx where we currently are, so this is the only type that works behind NAT or on an
  address that moves. Costs: inbound depends on a live registration (~180 s refresh), the password
  is a brute-forceable shared secret, and the transport cannot be pinned server-side.
- **`ip_connections`** — source-IP ACL, no registration, no secret, lowest overhead; requires a
  static public address and a firewall that accepts unsolicited INVITEs.
- **`fqdn_connections`** — inbound resolved through our DNS (A or SRV, with a `/v2/fqdns`
  sub-resource), outbound independently credential- or IP-authenticated. Gains SRV failover and
  drops the registration dependency; the natural upgrade once the deployment has stable DNS. Also
  the only type carrying `microsoft_teams_sbc`.

Credential connections are chosen because a tenant's Asterisk may sit anywhere, including behind
NAT on a developer's machine, and because they are the only shape that needs **zero** coordination
with the customer's network to work.
