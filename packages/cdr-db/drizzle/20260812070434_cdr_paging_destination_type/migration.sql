-- HAND-EDITED (comment only): `call_legs` is partitioned, so this drop/add pair recurses into every
-- partition and takes an ACCESS EXCLUSIVE lock while it revalidates each one. The check only WIDENS
-- — every value it accepted before it still accepts — so the scan cannot fail; it can still be slow
-- on a large history, which is why it is one statement in one transaction rather than a drop that
-- leaves the column unconstrained between two deploys.
ALTER TABLE "call_legs" DROP CONSTRAINT "call_legs_destination_type_check", ADD CONSTRAINT "call_legs_destination_type_check" CHECK ("destination_type" in ('extension', 'queue', 'ivr', 'ring_group', 'voicemail', 'conference', 'trunk', 'external', 'application', 'time_condition', 'park', 'paging', 'unknown'));
