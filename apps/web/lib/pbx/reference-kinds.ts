/**
 * Every `kind` the API can put in a `PBX_REFERENCED` body or a diagnostic subject.
 *
 * Copied from `DESTINATION_SITES` and the scalar reference sites in
 * `apps/api/src/pbx/shared/destinations.ts`, which that module keeps hand-maintained for the same
 * reason this one is: the value of the list is that a reviewer can see it.
 *
 * It lives in its own module rather than inside `references.ts` so the label table and the list it
 * must cover are not written in the same place — a list that is derived from the thing it checks
 * proves nothing.
 */
export const DESTINATION_SITE_KINDS: readonly string[] = [
	"phone-number",
	"inbound-route",
	"outbound-route",
	"time-condition",
	"ivr-menu",
	"ivr-menu-option",
	"ring-group",
	"ring-group-destination",
	"queue",
	"park-lot",
	"voicemail-option",
	// Scalar (non-destination) references the CRUD layer also refuses to orphan.
	"extension",
	"trunk",
	"voicemail-box",
	"feature-code",
	"conference",
	/**
	 * A phrase holds a scalar reference to the PROMPT each of its steps plays, so deleting a prompt a
	 * sequence still plays is refused and names the phrases. It is the only `on delete restrict`
	 * column in the schema — cascading would silently shorten the sentence — and the site is declared
	 * with `idColumn: "phrase_id"`, so the kind that appears in the 409 is `phrase` and never
	 * `phrase-step`. Adding `phrase-step` here would be a listing for a kind the server cannot emit.
	 */
	"phrase",
	/**
	 * A device holds a scalar reference to a device PROFILE, so deleting a profile a fleet still
	 * uses is refused and names the devices. That delete is the one place a `device` appears in a
	 * `PBX_REFERENCED` body — a device is never a destination, because a call is routed to an
	 * extension and the registrar decides which of its handsets ring.
	 */
	"device",
];
