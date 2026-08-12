import { z } from "zod/v4";
import { cdrListQuerySchema } from "../query/cdr.dto";

/**
 * What an export request may ask for.
 *
 * ## It is the list DTO, minus the two fields that are about a page
 *
 * `cdrListQuerySchema` is reused rather than restated, and that is the whole point of the split
 * `cdr.service.ts` recorded when it put the range ceiling in the service instead of the schema:
 * *"Keeping them apart is what lets an export path reuse the same DTO with a different ceiling
 * later."* This is later. Every filter the reporting screen can set — direction, disposition,
 * hangup cause, leg side, extension, DID, recorded-only, free-text search — means exactly what it
 * means on the screen, because it IS the same schema, and a filter the list gains is a filter the
 * export gains in the same commit.
 *
 * `limit` and `cursor` are stripped. They describe a PAGE, and an export is not paged: the worker
 * walks the whole result set with its own cursor and the client never sees one. Leaving them in
 * would let a client submit `limit: 25` and get a file with 25 rows in it, which is a plausible
 * request and completely the wrong answer.
 *
 * ## The window, and why the ceiling is different here
 *
 * `MAX_RANGE_DAYS` is 92 on the list because that is a request a person waits on. This path exists
 * precisely so a wider question can be asked, so the ceiling is {@link CDR_EXPORT_MAX_RANGE_DAYS}
 * and it is enforced in the service, in the same place and for the same reason the list's is: it
 * is a policy about cost, not about shape.
 *
 * ## The row cap, stated here because this is what a client reads
 *
 * An export is capped at {@link CDR_EXPORT_MAX_ROWS} rows. A job that reaches the cap FAILS with
 * `failureReason: "too-many-rows"` — it does not truncate. A truncated CSV is the worst possible
 * outcome: it is a plausible-looking file, it has no marker saying where it stopped, and somebody
 * will total a column in it. Failing loudly and telling the requester to narrow the window is the
 * only honest answer, and `failureDetail` says exactly that in a sentence.
 *
 * The cap is a real limit rather than a formality, and the reason is the object store. `put` takes
 * a `Buffer` — `local-object-store.ts` argues that a streaming write "would buy nothing but a
 * partially-written object on a mid-write failure" — so the CSV is assembled in memory before it
 * is stored. `MirroredObjectStore.put` names itself as the method that would grow an `upload` path
 * if object sizes stopped being small; raising this cap much further is that change, not a
 * configuration edit.
 */

/**
 * The widest window one export may cover, in days.
 *
 * A year plus a day. Chosen against the retention floor rather than against a page-render budget:
 * `packages/cdr-db/src/retention.ts` keeps thirteen months by default, so a year is the largest
 * window that is reliably ANSWERABLE — asking for two would silently return whatever survived the
 * partition drop, which is a report that is wrong in a way nobody can see. The extra day is for
 * the leap year, so "the whole of last year" is expressible on every calendar.
 */
export const CDR_EXPORT_MAX_RANGE_DAYS = 366;

/**
 * The most rows one export may contain.
 *
 * A hundred thousand legs is a large mid-market tenant's quarter, and at the ~250 bytes a row
 * serializes to it is a file of roughly 25 MB — which is the number this cap is really about, for
 * the buffered-write reason above. Overridable per deployment through `CDR_EXPORT_MAX_ROWS`.
 */
export const CDR_EXPORT_MAX_ROWS = 100_000;

/** Exports one tenant may have in flight at once, so one client cannot fill the worker's queue. */
export const CDR_EXPORT_MAX_PENDING = 5;

/**
 * The list DTO's shape with the two paging fields removed.
 *
 * `omit()` rather than a destructure with discarded bindings: the lint rule against unused
 * variables is right that `const { limit: _limit, … }` is a declaration nobody reads, and Zod's own
 * operator says what is happening without the ceremony.
 */
const exportFilterShape = cdrListQuerySchema.omit({ limit: true, cursor: true }).shape;

export const createCdrExportDto = z.strictObject({
	...exportFilterShape,
	/**
	 * A name for the requester's own benefit, echoed back on the job and never used as a file name.
	 *
	 * Not the file name, deliberately: the object key is derived from the job id
	 * (`exports/<org>/<id>.csv`) so it is unguessable, collision-free and safe to hand to a
	 * filesystem. A user-chosen string in an object key is a path-traversal question this area does
	 * not need to have — `object-path.ts` would catch it, and the right way not to rely on that is
	 * not to put user input in a key at all. The download response sets the human-readable name in
	 * `content-disposition` instead, which is where a name belongs.
	 */
	label: z.string().trim().max(128).optional(),
});

export type CreateCdrExportDto = z.infer<typeof createCdrExportDto>;

/**
 * The export listing. Keyset-paged like every other list in this area, never counted.
 *
 * `status` narrows to one lifecycle state so a client polling for "is mine done yet" does not have
 * to page through a year of finished ones.
 */
export const cdrExportListQuerySchema = z.object({
	status: z.enum(["queued", "running", "succeeded", "failed"]).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(25),
	cursor: z.string().max(256).optional(),
});

export type CdrExportListQuery = z.infer<typeof cdrExportListQuerySchema>;
