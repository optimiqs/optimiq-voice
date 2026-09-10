# Runbook — answering an Industry Traceback Group request

**The clock is 24 hours from receipt.** It is not a target. The FCC's September 2025 group order was
against twelve providers who had certified a 24-hour traceback commitment in the Robocall Mitigation
Database and then missed it, and the 2026 RMD rules turn that commitment into an annual
recertification. A missed traceback is a filing problem before it is an engineering problem.

This page is the whole procedure. It assumes nothing about who is on call.

## Who answers

The platform operator on call. Concretely: whoever holds the `compliance.traceback` permission. That
grant is deliberately separate from `compliance.review` (which approves customer onboarding) so that
an on-call operator can answer a traceback at 02:00 without also holding the authority to accept a
new customer. Both sit in `OWNER_ONLY_PERMISSIONS` — see `packages/auth/src/permissions.ts`.

If nobody on call holds it, that is the first thing to fix, not something to work around by handing
out a database password.

## What arrives

An ITG request names, at minimum:

- a **called number** (and often a calling number),
- a **date and time**, usually with a timezone that is not UTC,
- sometimes a **SIP Call-ID** or an `origid` from the upstream provider,
- the hop that handed the call to us.

## The query

One request, on the platform-operator surface:

```
GET /api/v1/platform/traceback
    ?from=<ISO 8601 instant>
    &to=<ISO 8601 instant>
    &calledNumber=+1XXXXXXXXXX      # and/or callingNumber
    &trunkId=<uuid>                 # optional, when the hop is known
```

Convert the requester's local time to UTC before you send it, and widen the window by an hour on
each side on the first attempt. A traceback that names "14:30" rarely means the instant the INVITE
arrived.

The answer carries, per matched leg:

| Field                                                 | What the ITG form calls it                                   |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `organizationId`, organization name, KYC decision     | the originating customer, and whether we had accepted them   |
| `startedAt`, `direction`, `durationMs`, `disposition` | the call itself                                              |
| `fromNumber`, `toNumber`                              | calling and called party                                     |
| `sipCallId`                                           | the dialog identifier                                        |
| `trunkRef`                                            | the trunk the call crossed                                   |
| `signalingAddress`                                    | the source IP of the signalling                              |
| `sipAttestation`, `sipVerstat`, `sipOrigId`           | what the upstream carrier asserted, on an inbound call       |
| `expectedAttestation`, `callerIdRightToUse`           | what **we** asserted, on an outbound call, and on what basis |

Add `/export.csv` to the same query for a file to attach to the response form.

The two attestation pairs answer different questions and the ITG asks both. `sipAttestation` is
somebody else's claim about traffic that reached us. `expectedAttestation` is our own decision under
the April 2026 FNPRM, and `callerIdRightToUse` is the fact behind it: `owned` means the calling
number is a DID this platform assigned to that customer, `verified` means an external number with a
documented verification on file, and an empty value means neither — which is a C, and is exactly the
call a traceback is usually about.

## Why the query is fast, and what to do if it is not

`call_legs` is partitioned by `started_at` and every tenant-facing index leads with
`organization_id`. A traceback is the one question that has no tenant, so `cdr-db` carries three
indexes that deliberately do not lead with it — `call_legs_traceback_to_idx`,
`call_legs_traceback_from_idx` and `call_legs_trunk_idx` (see the header in
`packages/cdr-db/src/schema/call-leg-schema.ts`). Always bound the time range: it is the partition
key, and an unbounded query is a scan of every month the ledger has kept.

If a window returns nothing, before widening it further, check that the retention sweep has not
already dropped the partition — `packages/cdr-db/src/partitions.ts` and the tenant's retention
setting. "The record was retained out" is a legitimate answer to the ITG and a very poor one to
discover on hour 23.

## Every query is audited

The endpoint writes an audit row naming the operator, the numbers queried, the window and the number
of rows returned. That is deliberate and it cuts both ways: it is a cross-tenant read of customer
call records, so it must leave a trace, and it is also the evidence that we answered — the audit row
is the timestamp that proves the 24-hour clock was met.

## Then

1. Fill the ITG form with the rows above. Attach the CSV.
2. If the originating customer is one of ours, open the customer's KYC file
   (`GET /api/v1/platform/compliance/kyc`) and read the decision and the reviewer's notes. A
   traceback against a customer whose file is `pending` or `needs-info` is a signal about the
   onboarding process, not only about the call.
3. If the pattern justifies it, the tenant-side controls are: set
   `compliance.unverifiedCallerIdPolicy` to `refuse` on that organization, turn on
   `compliance.requireKycForOutbound`, or use the toll-fraud controls. All three take effect on the
   next routing compile.
4. Record the response date. The RMD recertification asks for it.

## Related

- `docs/recording-compliance.md` — consent, retention and erasure.
- `packages/routing/src/attestation.ts` — how the A/B/C decision is made, and why it is ours to make.
