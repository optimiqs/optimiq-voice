-- HAND-EDITED (comment only). `call_legs` is partitioned, so each statement here recurses into
-- every partition. Both ADD COLUMNs are metadata-only — nullable, no default — so they are cheap on
-- any history; see 20260812070434_cdr_paging_destination_type for why partitioned DDL is worth
-- being explicit about. No index: an authorisation code is read on a row somebody already found by
-- time and organization, and a partial index over a column that is null on nearly every call would
-- cost every insert to serve a report nobody has asked for yet.
--
-- Nothing is backfilled, and nothing could be. Outbound PIN gates were compiled into the artifact
-- before this deploy and enforced by nothing, so no call that predates it was ever authorised by a
-- code. A report over such a window shows no authorisations, which is the honest shape of "the gate
-- started working on this date" rather than a gap in the data.
--
-- Deliberately NOT stored: the digits. See `call-leg-schema.ts` — the ledger answers "who authorised
-- this" with the ordinal and label a tenant typed into a form, and must not become the best place on
-- the platform to go looking for a code to reuse.
ALTER TABLE "call_legs" ADD COLUMN "auth_pin_ordinal" integer;--> statement-breakpoint
ALTER TABLE "call_legs" ADD COLUMN "auth_pin_label" text;