import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, namedDestinationColumns } from "./columns";

/**
 * Audio streams — an HTTP(S) or Icecast source a caller can be sent to.
 *
 * # It already half-existed, and that is the point of this table
 *
 * `moh_class.source = "stream"` + `moh_class.stream_uri` already let a tenant hold callers on a
 * remote stream. What it does not let them do is *route* to one: an IVR option that plays the
 * shop's radio feed, a DID that answers into a live announcement channel, an after-hours branch
 * that plays a rolling status bulletin. Upstream models Streams as a first-class object for exactly
 * that reason and so does this. The music-on-hold path is unchanged and keeps its own column; a
 * stream row is not a music-on-hold class and neither is convertible into the other, because one is
 * held-call decoration and the other is where the call went.
 *
 * # The fallback trio is not optional decoration
 *
 * Remote-URL playback is the one thing in this schema whose availability depends on the media driver
 * rather than on the configuration. Asterisk's ARI `POST /channels/{id}/play` takes a media URI from
 * a closed set of schemes — `sound:`, `recording:`, `number:`, `digits:`, `characters:`, `tone:` —
 * and an arbitrary `https://` is not one of them. A driver that cannot play the stream must not drop
 * the call in silence, so every stream carries somewhere to go instead, and the compiler refuses a
 * stream that has no fallback rather than compiling a dead end.
 *
 * That is why the trio is written with `namedDestinationColumns` (nullable columns) and then made
 * mandatory by a NON-optional shape check: the builder pair for "required trio" is
 * `destinationColumns()`, which occupies the unprefixed names, and those are reserved for a table's
 * PRIMARY destination — which a stream does not have, because the stream itself is the destination.
 *
 * The fallback is also what a stream takes when the URL is simply unreachable at play time, which is
 * a strictly more common failure than an unsupported scheme: a remote source is somebody else's
 * uptime.
 */
export const audioStream = pgTable.withRLS(
	"audio_stream",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		description: text("description"),
		/**
		 * The source URL. Validated at write time to be `http`/`https` and nothing else — no `file:`,
		 * no `sofia:`, no scheme-less string a media server might interpret as a local path. A stream
		 * is a URL a tenant typed, and the set of things a tenant may cause the media server to open
		 * is a security decision rather than a formatting one.
		 */
		url: text("url").notNull(),
		/**
		 * Whether the caller's leg is answered before the stream is played.
		 *
		 * `true` is the ordinary case and the one that bills: early media on a leg that is never
		 * answered is free to the caller and free to the tenant, which sounds like a feature until a
		 * carrier's SBC drops it after thirty seconds. `false` is here for the announcement case where
		 * answering is exactly what the tenant is trying to avoid.
		 */
		answerFirst: boolean("answer_first").notNull().default(true),
		/**
		 * How long the caller listens before the fallback is taken. Zero means "until they hang up",
		 * which is what an always-on radio feed wants and what a status bulletin does not.
		 */
		maxSeconds: integer("max_seconds").notNull().default(0),
		/** Where the call goes when the stream ends, times out, or cannot be played at all. */
		...namedDestinationColumns("fallback"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("audio_stream_organization_name_key").on(table.organizationId, table.name),
		index("audio_stream_organization_enabled_idx").on(table.organizationId, table.enabled),
		// Deliberately NOT `optional`: see the header. A stream with no fallback is a dead end on a
		// driver that cannot play it, and this is the constraint that makes that unrepresentable.
		destinationCheck("audio_stream", "fallback"),
		tenantIsolationPolicy("audio_stream"),
	],
);
