/**
 * Quiet hours, as a pure function of a campaign window and an instant.
 *
 * # What this is for
 *
 * The TCPA restricts telephone solicitations to 8am–9pm in the *called party's* local time, and every
 * carrier's reading of the CTIA principles applies the same window to promotional A2P text. A
 * campaign declares its window; this decides whether a send is inside it.
 *
 * # The one thing this deliberately gets "wrong", stated plainly
 *
 * The window is evaluated in the CAMPAIGN's declared time zone, not the recipient's. The recipient's
 * zone is the legally interesting one, and this platform does not know it: deriving it from the area
 * code of a mobile number has been unreliable since number portability, and guessing it would
 * produce a system that is confidently wrong about the exact fact a plaintiff would litigate.
 *
 * So the design is honest instead of clever: the tenant declares the zone their program is scoped to
 * — which for the overwhelming majority of these numbers is the single region a local business
 * serves — and this enforces it. A tenant messaging across zones sets the window to the intersection
 * that is safe everywhere, which is what a compliance officer would tell them to do anyway. When a
 * verified recipient zone exists (a CRM field, a consent record), this function is where it plugs
 * in: pass it as `recipientTimeZone` and it wins.
 *
 * # Why an overnight window is supported
 *
 * `start > end` means the window wraps midnight. Quiet hours are usually expressed as the SENDABLE
 * window (8am–9pm, no wrap), but a campaign that instead declares its quiet period (21:00–08:00)
 * would otherwise silently mean "never sendable". Supporting the wrap costs one comparison and
 * removes a class of misconfiguration that is invisible until nothing sends.
 */

/** A campaign's declared window: the minutes past local midnight during which sending is allowed. */
export interface QuietHoursWindow {
	/** Inclusive start, 0–1439. */
	readonly startMinute: number;
	/** Exclusive end, 0–1439. When less than `startMinute`, the window wraps midnight. */
	readonly endMinute: number;
	/** IANA zone the two are read in. See the header for why this is the campaign's, not the recipient's. */
	readonly timeZone: string;
}

export interface QuietHoursDecision {
	readonly allowed: boolean;
	/** The local time the decision was made against, `HH:MM`, for the refusal message. */
	readonly localTime: string;
	/** The window, formatted the same way, so the refusal can quote both. */
	readonly window: string;
}

/**
 * Whether a send is inside the campaign's sendable window.
 *
 * A campaign with no window is always allowed — the common case, and the right default for a two-way
 * conversational inbox where a reply at 22:00 is a human answering a human rather than a broadcast.
 * Restricting THAT would break the feature to satisfy a rule that was never aimed at it.
 */
export function isWithinQuietHours(
	window: QuietHoursWindow | undefined,
	at: Date,
	recipientTimeZone?: string,
): QuietHoursDecision {
	if (window === undefined) {
		return { allowed: true, localTime: "", window: "" };
	}
	const zone = recipientTimeZone ?? window.timeZone;
	const minutes = localMinutesIn(zone, at);
	const allowed =
		window.startMinute <= window.endMinute
			? minutes >= window.startMinute && minutes < window.endMinute
			: // Wrapped: allowed at or after the start, OR before the end on the following day.
				minutes >= window.startMinute || minutes < window.endMinute;
	return {
		allowed,
		localTime: formatMinutes(minutes),
		window: `${formatMinutes(window.startMinute)}–${formatMinutes(window.endMinute)} ${zone}`,
	};
}

/**
 * Minutes past midnight in an IANA zone.
 *
 * `Intl.DateTimeFormat` rather than an offset table or a date library: it is the only correct source
 * for "what time is it there right now" — it carries the current tzdata, including the DST
 * transitions that make a fixed offset wrong twice a year — and it is in the runtime already.
 *
 * An unknown zone makes the constructor throw. That is caught and reported as UTC rather than
 * propagated, because the caller is a send path: a campaign row with a typo'd zone must not turn
 * every send into a 500. The window is still enforced, just against UTC, which is visible in the
 * refusal message the caller quotes.
 */
export function localMinutesIn(timeZone: string, at: Date): number {
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(at);
	} catch {
		return at.getUTCHours() * 60 + at.getUTCMinutes();
	}
	const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
	const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
	return hour * 60 + minute;
}

/** `HH:MM` for a minutes-past-midnight value. */
export function formatMinutes(minutes: number): string {
	const clamped = ((Math.trunc(minutes) % 1_440) + 1_440) % 1_440;
	const hour = Math.floor(clamped / 60);
	const minute = clamped % 60;
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Whether a string names a zone this runtime knows. Used by the DTO so a typo is a 400, not a 500. */
export function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}
