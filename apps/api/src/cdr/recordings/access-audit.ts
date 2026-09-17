/**
 * The audit trail for recording ACCESS, as the CDR area is allowed to reach it.
 *
 * Same wall and the same crossing as `purge-audit.ts` and `retention/leg-retention-audit.ts`: the
 * ledger is `audit_log` in `pbx-db`, the CDR area declares this port and imports nothing from the
 * PBX area, the PBX side implements it over its ledger machinery
 * (`pbx/shared/recording-access-audit.service.ts`), and the caller injects it `@Optional()` so a
 * deployment without the PBX area keeps serving recordings.
 *
 * ## Why a read needs a ledger row at all
 *
 * The deletion paths have written to `audit_log` since they existed and the playback paths wrote
 * nothing, which makes the ledger answer "who destroyed this recording?" and shrug at "who
 * LISTENED to it?" — and the second question is the one a data-protection complaint, an HR
 * dispute and a PCI review all actually ask. A recording is a conversation between two people, and
 * a third person hearing it is an event with a subject, a data subject and a lawful basis. The
 * destruction of that recording is comparatively benign. So both are recorded now, in one ledger,
 * with one vocabulary, so that "everything that ever happened to recording X" is a single lookup
 * on `resource_ref` rather than a log-aggregation exercise.
 *
 * ## Two actions, because minting and opening are two different facts
 *
 * `recording.download-url` is an authenticated, permission-gated decision: this person, in this
 * organization, was authorised to hear this recording for the next few minutes. `recording.play`
 * is somebody actually fetching the bytes with that credential. They are separated because they
 * genuinely come apart: a link minted and never followed is an authorisation that was granted and
 * not used, and a link followed four times is one authorisation and four listens — possibly from
 * four different addresses, which is exactly the shape of a leaked URL. Collapsing them into one
 * row would make both of those invisible.
 *
 * ## The token actor is honest about having no person behind it
 *
 * Following a signed link is anonymous BY CONSTRUCTION — that is the whole point of the scheme,
 * because an `<audio src>` cannot carry a session — so the media row has no user to attribute. It
 * is recorded as what it is: the ledger's `system` actor type, with the token's own subject (the
 * recording it names) in `actor_ref`, and the request's address and user-agent, which are the only
 * identifying facts that genuinely exist at that moment. Attributing the fetch to whoever minted
 * the link would be a fabrication — the minter and the fetcher are frequently not the same party,
 * which is precisely why the link scheme exists — and a ledger that guesses is worse than one that
 * says "a bearer of this token, from this address".
 */

/** Who reached the media. See the header for why `token` is not folded into `user`. */
export interface RecordingAccessActor {
	/** `user` for a session-backed mint; `token` for an anonymous fetch of a signed URL. */
	readonly kind: "user" | "token";
	/** The caller's `user.id`, for a `user` actor. Never invented for a `token` one. */
	readonly userId: string | null;
	/** The token's subject for a `token` actor; the API-key id, if any, for a `user` one. */
	readonly ref: string | null;
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
}

/** One access event. `detail` lands in the ledger's `after` column. */
export interface RecordingAccessAuditEntry {
	/** `recordings.id` in the CDR database. */
	readonly recordingId: string;
	/** `download-url` for a mint, `play` for a signed-token open. */
	readonly event: "download-url" | "play";
	readonly actor: RecordingAccessActor;
	/** Whatever makes the row answerable later — the object key, the link's lifetime. */
	readonly detail: Record<string, unknown>;
}

export interface RecordingAccessAudit {
	recordAccess(organizationId: string, entry: RecordingAccessAuditEntry): Promise<void>;
}

/** Nest injection token for {@link RecordingAccessAudit}. */
export const RECORDING_ACCESS_AUDIT = Symbol("RECORDING_ACCESS_AUDIT");
