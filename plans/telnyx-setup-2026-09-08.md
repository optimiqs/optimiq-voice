# Telnyx setup and live acceptance

## Observed in the signed-in portal

Read-only inspection on 2026-09-08 found one listed SIP connection, `Optimiq eFax DGX`, inactive and using credential authentication. The `Default` outbound voice profile is active. Both currently owned active numbers are assigned to fax services: `Optimiq Health Fax` and `Optimiq eFax DGX`. They are not established as dedicated voice test lines. Emergency services are disabled on both. No existing connection, number, forwarding rule or billing setting was changed.

## Dedicated voice setup

Use a separate `Optimiq Voice` SIP connection to isolate calling deployment and tests from existing fax services. The application currently integrates Telnyx credential connections and their outbound profiles. Public SIP/TLS endpoints, media addresses and callback URLs must match the chosen host. Configure inbound number routing to the dedicated connection, then map that number to the correct organization and inbound route in the application.

The portal offers Credentials, IP Address, FQDN, UAC and Teams connections. Opening the creation form did not create a connection. Credential creation and its final authorization are pending a concrete deployment target. Do not purchase or move a number before the selected line and spending limit are known.

## Pending user details

- Deployment server and public SIP domain.
- A controlled destination number for live calling tests.
- Maximum live test-call budget and choice of a dedicated inbound number.

## Acceptance evidence

The existing disposable full-stack tests prove signup/verification, membership, extension assignment, WSS registration, extension routing, two-way audio, a 35-second hold/resume, both CDR legs, media cleanup and recovery from late configuration startup. They use synthetic accounts and locally captured mail, with no external messages or carrier calls.

Live carrier acceptance remains unperformed. It must independently verify credential registration, outbound calling, inbound DID routing, caller ID, two-way media, DTMF, hold/resume, transfer, disconnect causes and carrier recovery using approved test endpoints. Emergency activation and its approved test procedure are separate from ordinary call acceptance.
