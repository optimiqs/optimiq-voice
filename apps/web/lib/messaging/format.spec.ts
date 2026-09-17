import { describe, expect, it } from "bun:test";
import {
	conversationPreview,
	conversationTitle,
	formatE164,
	messageStatusPresentation,
	minutesToTime,
	PREVIEW_MAX_LENGTH,
	quietHoursDurationMinutes,
	registrationStatusPresentation,
	relativeTime,
	retentionLabel,
	timeToMinutes,
	truncatePreview,
	unreadBadgeLabel,
} from "./format";
import type { ConversationRow } from "./contracts";

const NOW = new Date("2026-02-17T12:00:00.000Z");

function conversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
	return {
		id: "c1",
		organizationId: "org",
		messagingNumberId: "n1",
		remoteE164: "+15551234567",
		displayName: null,
		lastMessagePreview: "Hello there",
		lastMessageAt: "2026-02-17T11:58:00.000Z",
		unreadCount: 0,
		archived: false,
		createdAt: "2026-02-01T00:00:00.000Z",
		updatedAt: "2026-02-17T11:58:00.000Z",
		...overrides,
	};
}

describe("formatE164", () => {
	it("writes a NANP number the way the continent reads it", () => {
		expect(formatE164("+15551234567")).toBe("+1 (555) 123-4567");
	});

	it("groups a non-NANP number after the country code", () => {
		expect(formatE164("+442071234567")).toBe("+4 420 712 345 67");
	});

	/**
	 * A value the API did not give as E.164 is returned untouched rather than mangled. A formatter
	 * that "corrects" its input hides the bug that produced it.
	 */
	it("leaves anything that is not E.164 alone", () => {
		expect(formatE164("1001")).toBe("1001");
		expect(formatE164("")).toBe("");
		expect(formatE164("not a number")).toBe("not a number");
	});
});

describe("conversationTitle", () => {
	it("prefers the stored display name", () => {
		expect(conversationTitle({ displayName: "Dana Ruiz", remoteE164: "+15551234567" })).toBe(
			"Dana Ruiz",
		);
	});

	/** A thread with no name IS the number — never a placeholder that says nothing twice. */
	it("falls back to the formatted number, including for a whitespace-only name", () => {
		expect(conversationTitle({ displayName: null, remoteE164: "+15551234567" })).toBe(
			"+1 (555) 123-4567",
		);
		expect(conversationTitle({ displayName: "   ", remoteE164: "+15551234567" })).toBe(
			"+1 (555) 123-4567",
		);
	});
});

describe("relativeTime", () => {
	it("uses the shortest true unit so a column of ages compares at a glance", () => {
		expect(relativeTime("2026-02-17T11:59:30.000Z", NOW)).toBe("now");
		expect(relativeTime("2026-02-17T11:45:00.000Z", NOW)).toBe("15m");
		expect(relativeTime("2026-02-17T09:00:00.000Z", NOW)).toBe("3h");
		expect(relativeTime("2026-02-15T12:00:00.000Z", NOW)).toBe("2d");
	});

	/** Past a week it becomes a date: "37d" is a number nobody converts in their head. */
	it("switches to a date past a week", () => {
		expect(relativeTime("2026-01-02T12:00:00.000Z", NOW)).not.toMatch(/d$/u);
	});

	/** Clock skew between a handset and a server is routine and must not read as a negative age. */
	it("reads a future timestamp as now", () => {
		expect(relativeTime("2026-02-17T12:05:00.000Z", NOW)).toBe("now");
	});

	it("has an answer for a thread that has never had a message", () => {
		expect(relativeTime(null, NOW)).toBe("—");
		expect(relativeTime("not a date", NOW)).toBe("—");
	});
});

describe("truncatePreview", () => {
	it("leaves a short message untouched — and in particular gives it no ellipsis", () => {
		expect(truncatePreview("Running five minutes late")).toBe("Running five minutes late");
	});

	it("collapses newlines so a two-line message cannot blow the row height open", () => {
		expect(truncatePreview("first\n\nsecond")).toBe("first second");
	});

	it("truncates to the limit with a single ellipsis glyph", () => {
		const long = "a".repeat(PREVIEW_MAX_LENGTH + 20);
		const preview = truncatePreview(long);

		expect(preview).toHaveLength(PREVIEW_MAX_LENGTH);
		expect(preview.endsWith("…")).toBe(true);
	});

	it("treats an absent preview as an empty one", () => {
		expect(truncatePreview(null)).toBe("");
	});
});

describe("conversationPreview", () => {
	it("says an attachment-only message is an attachment rather than rendering a blank cell", () => {
		expect(conversationPreview(conversation({ lastMessagePreview: null }))).toBe("Attachment");
	});

	it("distinguishes an empty thread from an attachment", () => {
		expect(
			conversationPreview(conversation({ lastMessagePreview: null, lastMessageAt: null })),
		).toBe("No messages yet");
	});
});

describe("unreadBadgeLabel", () => {
	it("renders nothing at zero, so a read thread carries no badge at all", () => {
		expect(unreadBadgeLabel(0)).toBe("");
		expect(unreadBadgeLabel(-1)).toBe("");
	});

	it("caps at 99+, past which the exact number stops being information", () => {
		expect(unreadBadgeLabel(3)).toBe("3");
		expect(unreadBadgeLabel(99)).toBe("99");
		expect(unreadBadgeLabel(1200)).toBe("99+");
	});
});

describe("registrationStatusPresentation", () => {
	/**
	 * The four map to four distinct tones, and the gap that matters is rejected against
	 * unregistered: one is a task nobody has started, the other is a refusal with a stated reason.
	 */
	it("maps each status to its own tone and label", () => {
		expect(registrationStatusPresentation("registered")).toEqual({
			label: "Registered",
			tone: "success",
		});
		expect(registrationStatusPresentation("pending")).toEqual({
			label: "Pending",
			tone: "warning",
		});
		expect(registrationStatusPresentation("rejected")).toEqual({
			label: "Rejected",
			tone: "danger",
		});
		expect(registrationStatusPresentation("unregistered")).toEqual({
			label: "Not registered",
			tone: "neutral",
		});
	});
});

describe("messageStatusPresentation", () => {
	/**
	 * Only `delivered` is green. `sent` means the carrier took it and nothing has confirmed a phone
	 * received it — painting both green would erase the delivery receipt the column exists for.
	 */
	it("keeps sent and delivered visually apart", () => {
		expect(messageStatusPresentation("sent").tone).toBe("neutral");
		expect(messageStatusPresentation("delivered").tone).toBe("success");
		expect(messageStatusPresentation("failed").tone).toBe("danger");
	});
});

describe("retentionLabel", () => {
	it("says what null means rather than leaving the cell blank", () => {
		expect(retentionLabel(null)).toBe("Organization default");
		expect(retentionLabel(90)).toBe("90 days");
	});
});

describe("quiet-hours time conversion", () => {
	it("round-trips a wall-clock time through minutes past midnight", () => {
		expect(timeToMinutes("21:00")).toBe(1260);
		expect(minutesToTime(1260)).toBe("21:00");
		expect(timeToMinutes("00:00")).toBe(0);
		expect(minutesToTime(0)).toBe("00:00");
		expect(minutesToTime(timeToMinutes("08:30") ?? -1)).toBe("08:30");
	});

	it("accepts a single-digit hour and always emits a padded one", () => {
		expect(timeToMinutes("9:05")).toBe(545);
		expect(minutesToTime(545)).toBe("09:05");
	});

	/** Total rather than NaN: a caller must never be able to put NaN on the wire. */
	it("returns null for anything that is not a time", () => {
		expect(timeToMinutes("")).toBeNull();
		expect(timeToMinutes("2400")).toBeNull();
		expect(timeToMinutes("25:00")).toBeNull();
		expect(timeToMinutes("21:60")).toBeNull();
		expect(timeToMinutes("nine")).toBeNull();
	});

	/** 24:00 is midnight, and minutes past a day wrap into the next one. */
	it("wraps rather than clamps", () => {
		expect(timeToMinutes("24:00")).toBe(1440);
		expect(minutesToTime(1440)).toBe("00:00");
		expect(minutesToTime(1500)).toBe("01:00");
		expect(minutesToTime(-60)).toBe("23:00");
	});
});

describe("quietHoursDurationMinutes", () => {
	it("measures an ordinary same-day window", () => {
		expect(quietHoursDurationMinutes("09:00", "17:00")).toBe(480);
	});

	/** 21:00 → 08:00 crosses midnight. That is the usual case for quiet hours, not an error. */
	it("wraps a window that crosses midnight", () => {
		expect(quietHoursDurationMinutes("21:00", "08:00")).toBe(660);
	});

	/** Equal ends mean a full day of quiet — never zero, which would read as "always send". */
	it("treats equal ends as a whole day", () => {
		expect(quietHoursDurationMinutes("09:00", "09:00")).toBe(1440);
	});

	it("has no answer for an unparseable end", () => {
		expect(quietHoursDurationMinutes("09:00", "nope")).toBeNull();
	});
});
