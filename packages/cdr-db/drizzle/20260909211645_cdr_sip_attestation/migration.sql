-- HAND-EDITED (comment only). `call_legs` is partitioned, so each statement here recurses into
-- every partition. All three ADD COLUMNs are metadata-only — nullable, no default — so they are
-- cheap on any history; see 20260812070434_cdr_paging_destination_type for why partitioned DDL is
-- worth being explicit about. No index: an attestation is read on a row somebody already found by
-- time and organization — a traceback starts from a call, not from an origid — and a column that is
-- null on nearly every leg would cost every insert to serve a report nobody has asked for yet.
--
-- Nothing is backfilled, and nothing could be. The SIP edge did not read `P-Asserted-Identity`,
-- `verstat` or `Identity` before this deploy, so no call that predates it ever carried a carrier
-- claim into the engine. A report over such a window shows no attestations, which is the honest
-- shape of "we started recording this on this date" rather than a gap in the data.
--
-- Visibility only, and never an authorisation. See `call-leg-schema.ts`: the carrier verifies and
-- states the outcome, this platform verifies nothing, and no routing decision reads these columns.
-- Deliberately NOT stored: the `Identity` JWS itself — multi-kilobyte, unverified here, and a field
-- nobody checks that looks like proof is worse than no field.
ALTER TABLE "call_legs" ADD COLUMN "sip_attestation" text;--> statement-breakpoint
ALTER TABLE "call_legs" ADD COLUMN "sip_verstat" text;--> statement-breakpoint
ALTER TABLE "call_legs" ADD COLUMN "sip_orig_id" text;
