import { describe, expect, it } from "bun:test";
import {
	EMPTY_FOLLOW_ME,
	EMPTY_FOLLOW_ME_TARGET,
	followMeFieldErrors,
	followMeSummary,
	moveFollowMeTarget,
	normalizeFollowMe,
	readFollowMe,
	sameFollowMe,
	writeFollowMe,
} from "./follow-me";
import { followMeFormSchema, MAX_FOLLOW_ME_TARGETS } from "./schemas";
import type { ExtensionRow } from "./contracts";
import type { FollowMeFormValues } from "./schemas";

/**
 * The follow-me ladder is the one field on the extension dialog whose column is REPLACED whole by a
 * PATCH, so two properties are load-bearing and neither is visible on screen:
 *
 * 1. **Read then write is a no-op.** A dialog opened and saved with nothing touched must produce a
 *    ladder identical to the stored one — otherwise the diff below never fires and every save
 *    rewrites the column.
 * 2. **`sameFollowMe` is what stops that write.** A false negative sends a `followMe` key nobody
 *    asked for; a false positive drops an edit the user made and reports success.
 *
 * The ranges are checked against the server's `followMeTarget` in
 * `apps/api/src/pbx/extensions/extensions.dto.ts`, on the same terms as `schemas.spec.ts`: this is
 * a mirror, so the mirror is what needs proving.
 */

function extensionWith(followMe: ExtensionRow["followMe"]): ExtensionRow {
	return { followMe } as ExtensionRow;
}

const LADDER: ExtensionRow["followMe"] = {
	enabled: true,
	ignoreBusy: true,
	targets: [
		{ destination: "1001", delaySeconds: 0, timeoutSeconds: 20, confirm: false },
		{ destination: "+12125550100", delaySeconds: 10, timeoutSeconds: 30, confirm: true },
	],
};

describe("normalizeFollowMe", () => {
	it("is null for an extension that has never used the feature", () => {
		expect(normalizeFollowMe(null)).toBeNull();
		expect(normalizeFollowMe(undefined)).toBeNull();
	});

	/**
	 * `{ enabled: false, targets: [] }` is a second spelling of "no follow-me". Left as-is it would
	 * differ from `null` on every comparison, so a dialog opened on such a row would send a
	 * `followMe` key on a save that changed nothing.
	 */
	it("collapses an empty disabled ladder to null", () => {
		expect(normalizeFollowMe({ enabled: false, targets: [] })).toBeNull();
	});

	/** An enabled ladder with no rungs is NOT nothing — it is a misconfiguration worth preserving. */
	it("keeps an enabled ladder with no rungs", () => {
		expect(normalizeFollowMe({ enabled: true, targets: [] })).toEqual({
			enabled: true,
			ignoreBusy: false,
			targets: [],
		});
	});

	it("defaults the two optional keys, so an absent one never reads as a change", () => {
		const normalized = normalizeFollowMe({
			enabled: true,
			targets: [{ destination: "1001", delaySeconds: 0, timeoutSeconds: 20 }],
		});
		expect(normalized?.ignoreBusy).toBe(false);
		expect(normalized?.targets[0]?.confirm).toBe(false);
	});
});

describe("readFollowMe", () => {
	it("opens empty for a create and for a row with no ladder", () => {
		expect(readFollowMe(null)).toEqual(EMPTY_FOLLOW_ME);
		expect(readFollowMe(extensionWith(null))).toEqual(EMPTY_FOLLOW_ME);
	});

	it("holds the seconds as strings, because every numeric control in this app does", () => {
		const values = readFollowMe(extensionWith(LADDER));
		expect(values.targets[0]).toEqual({
			destination: "1001",
			delaySeconds: "0",
			timeoutSeconds: "20",
			confirm: false,
		});
		expect(values.enabled).toBe(true);
		expect(values.ignoreBusy).toBe(true);
	});

	/** Order is the meaning: rung two rings ten seconds in, and reading must not sort it away. */
	it("preserves the order of the ladder", () => {
		const values = readFollowMe(extensionWith(LADDER));
		expect(values.targets.map((target) => target.destination)).toEqual(["1001", "+12125550100"]);
	});
});

describe("writeFollowMe", () => {
	it("clears the column when nothing is configured", () => {
		expect(writeFollowMe(followMeFormSchema.parse(EMPTY_FOLLOW_ME))).toBeNull();
	});

	/**
	 * Switching the feature off is not a request to delete the ladder behind it — the same rule
	 * `confirmPromptId` follows on a ring group. An operator who turns it off for a week and back on
	 * must not have to retype four numbers.
	 */
	it("keeps a switched-off ladder that still holds rungs", () => {
		const values: FollowMeFormValues = {
			enabled: false,
			ignoreBusy: false,
			targets: [{ destination: "1001", delaySeconds: "0", timeoutSeconds: "20", confirm: false }],
		};
		const payload = writeFollowMe(followMeFormSchema.parse(values));
		expect(payload).toEqual({
			enabled: false,
			ignoreBusy: false,
			targets: [{ destination: "1001", delaySeconds: 0, timeoutSeconds: 20, confirm: false }],
		});
	});

	it("sends the seconds as integers, which is what the DTO accepts", () => {
		const values: FollowMeFormValues = {
			enabled: true,
			ignoreBusy: false,
			targets: [{ destination: "1001", delaySeconds: "5", timeoutSeconds: "45", confirm: true }],
		};
		const payload = writeFollowMe(followMeFormSchema.parse(values));
		expect(payload?.targets[0]?.delaySeconds).toBe(5);
		expect(payload?.targets[0]?.timeoutSeconds).toBe(45);
	});
});

describe("the round trip, which is what makes the diff-only save safe", () => {
	/**
	 * Open the dialog, touch nothing, press Save: the ladder that comes out must be the ladder that
	 * went in. If it is not, `sameFollowMe` reports a change on every save and the column is
	 * rewritten from the form on every unrelated edit.
	 */
	it("read then write reproduces the stored ladder exactly", () => {
		const stored = normalizeFollowMe(LADDER);
		const rewritten = writeFollowMe(followMeFormSchema.parse(readFollowMe(extensionWith(LADDER))));
		expect(rewritten).toEqual(stored);
		expect(sameFollowMe(stored, rewritten)).toBe(true);
	});

	/** And for the common case: a row that has never carried a ladder must still send nothing. */
	it("read then write of nothing stays nothing", () => {
		const rewritten = writeFollowMe(followMeFormSchema.parse(readFollowMe(extensionWith(null))));
		expect(sameFollowMe(normalizeFollowMe(null), rewritten)).toBe(true);
	});

	/** Including the row whose ladder was stored in the other spelling of "nothing". */
	it("read then write of an empty disabled ladder stays nothing", () => {
		const row = extensionWith({ enabled: false, targets: [] });
		const rewritten = writeFollowMe(followMeFormSchema.parse(readFollowMe(row)));
		expect(sameFollowMe(normalizeFollowMe(row.followMe), rewritten)).toBe(true);
	});
});

describe("sameFollowMe", () => {
	it("notices the switch, the busy rule and a changed number", () => {
		const stored = normalizeFollowMe(LADDER);
		expect(sameFollowMe(stored, stored === null ? null : { ...stored, enabled: false })).toBe(
			false,
		);
		expect(sameFollowMe(stored, stored === null ? null : { ...stored, ignoreBusy: false })).toBe(
			false,
		);
		const retyped =
			stored === null
				? null
				: {
						...stored,
						targets: stored.targets.map((target, index) =>
							index === 1 ? { ...target, destination: "+12125550199" } : target,
						),
					};
		expect(sameFollowMe(stored, retyped)).toBe(false);
	});

	/** Reordering is the whole point of Up/Down, so two rungs swapped must not read as unchanged. */
	it("notices a reorder, because order decides which phone rings first", () => {
		const stored = normalizeFollowMe(LADDER);
		const reversed =
			stored === null ? null : { ...stored, targets: [...stored.targets].toReversed() };
		expect(sameFollowMe(stored, reversed)).toBe(false);
	});

	it("notices a per-rung confirmation change, which is invisible in a summary", () => {
		const stored = normalizeFollowMe(LADDER);
		const flipped =
			stored === null
				? null
				: {
						...stored,
						targets: stored.targets.map((target, index) =>
							index === 0 ? { ...target, confirm: true } : target,
						),
					};
		expect(sameFollowMe(stored, flipped)).toBe(false);
	});

	it("treats an absent confirm and an explicit false as the same rung", () => {
		expect(
			sameFollowMe(
				{
					enabled: true,
					ignoreBusy: false,
					targets: [{ destination: "1001", delaySeconds: 0, timeoutSeconds: 20 }],
				},
				{
					enabled: true,
					ignoreBusy: false,
					targets: [{ destination: "1001", delaySeconds: 0, timeoutSeconds: 20, confirm: false }],
				},
			),
		).toBe(true);
	});

	it("compares null against a ladder without pretending they match", () => {
		expect(sameFollowMe(null, null)).toBe(true);
		expect(sameFollowMe(null, normalizeFollowMe(LADDER))).toBe(false);
		expect(sameFollowMe(normalizeFollowMe(LADDER), null)).toBe(false);
	});
});

describe("followMeFieldErrors, mirroring the server's followMeTarget", () => {
	/** The keys carry dots of their own, so they are read directly rather than as a nested path. */
	function messageFor(values: FollowMeFormValues, key: string): string | undefined {
		return followMeFieldErrors(values)[`targets.${key}`];
	}

	function ladderOf(target: Partial<FollowMeFormValues["targets"][number]>): FollowMeFormValues {
		return {
			enabled: true,
			ignoreBusy: false,
			targets: [{ ...EMPTY_FOLLOW_ME_TARGET, destination: "1001", ...target }],
		};
	}

	it("says nothing about a ladder the server would accept", () => {
		expect(followMeFieldErrors(ladderOf({}))).toEqual({});
	});

	/** The key is the row and the box, so a ladder of six says which rung is wrong. */
	it("keys a message to the rung and the control that produced it", () => {
		const errors = followMeFieldErrors({
			enabled: true,
			ignoreBusy: false,
			targets: [
				{ ...EMPTY_FOLLOW_ME_TARGET, destination: "1001" },
				{ ...EMPTY_FOLLOW_ME_TARGET, destination: "" },
			],
		});
		expect(Object.keys(errors)).toEqual(["targets.1.destination"]);
	});

	it("refuses a destination that is not dialable", () => {
		expect(
			messageFor(ladderOf({ destination: "sip:alice@example.com" }), "0.destination"),
		).toBeString();
	});

	/** `delaySeconds` is `z.int().min(0).max(300)` on the server, and blank is a 400, not a default. */
	it("bounds the delay at 0 and 300 and refuses a blank one", () => {
		expect(followMeFieldErrors(ladderOf({ delaySeconds: "0" }))).toEqual({});
		expect(followMeFieldErrors(ladderOf({ delaySeconds: "300" }))).toEqual({});
		expect(messageFor(ladderOf({ delaySeconds: "301" }), "0.delaySeconds")).toBeString();
		expect(messageFor(ladderOf({ delaySeconds: "-1" }), "0.delaySeconds")).toBeString();
		expect(messageFor(ladderOf({ delaySeconds: "" }), "0.delaySeconds")).toBeString();
		expect(messageFor(ladderOf({ delaySeconds: "1.5" }), "0.delaySeconds")).toBeString();
	});

	/** `timeoutSeconds` starts at 1: a rung that rings for zero seconds never rings. */
	it("bounds the timeout at 1 and 300", () => {
		expect(followMeFieldErrors(ladderOf({ timeoutSeconds: "1" }))).toEqual({});
		expect(followMeFieldErrors(ladderOf({ timeoutSeconds: "300" }))).toEqual({});
		expect(messageFor(ladderOf({ timeoutSeconds: "0" }), "0.timeoutSeconds")).toBeString();
		expect(messageFor(ladderOf({ timeoutSeconds: "301" }), "0.timeoutSeconds")).toBeString();
	});

	/**
	 * The server's `.max(10)`. Caught here because the server's path (`followMe.targets`) collapses
	 * to one message on the whole section, which does not say which rung to delete.
	 */
	it("caps the ladder at the server's ten rungs", () => {
		const rung = { ...EMPTY_FOLLOW_ME_TARGET, destination: "1001" };
		const atCap: FollowMeFormValues = {
			enabled: true,
			ignoreBusy: false,
			targets: Array.from({ length: MAX_FOLLOW_ME_TARGETS }, () => rung),
		};
		expect(followMeFieldErrors(atCap)).toEqual({});
		expect(
			followMeFieldErrors({ ...atCap, targets: [...atCap.targets, rung] }).targets,
		).toBeString();
	});

	/** An empty ladder is legal — the server accepts it, and the editor warns instead of refusing. */
	it("accepts an enabled ladder with no rungs, because the server does", () => {
		expect(followMeFieldErrors({ enabled: true, ignoreBusy: false, targets: [] })).toEqual({});
	});
});

describe("moveFollowMeTarget", () => {
	const a = { ...EMPTY_FOLLOW_ME_TARGET, destination: "1001" };
	const b = { ...EMPTY_FOLLOW_ME_TARGET, destination: "1002" };
	const c = { ...EMPTY_FOLLOW_ME_TARGET, destination: "1003" };

	it("swaps a rung with its neighbour", () => {
		expect(moveFollowMeTarget([a, b, c], 1, -1)).toEqual([b, a, c]);
		expect(moveFollowMeTarget([a, b, c], 1, 1)).toEqual([a, c, b]);
	});

	/** A move off either end is a no-op, not a wrap: Up on rung one must not send it to the bottom. */
	it("refuses to move off either end", () => {
		const targets = [a, b, c];
		expect(moveFollowMeTarget(targets, 0, -1)).toBe(targets);
		expect(moveFollowMeTarget(targets, 2, 1)).toBe(targets);
	});
});

describe("followMeSummary, which is what the extensions list badges", () => {
	it("says nothing for a row with no ladder", () => {
		expect(followMeSummary(null)).toBeUndefined();
		expect(followMeSummary(undefined)).toBeUndefined();
	});

	/**
	 * A stored-but-disabled ladder changes nothing about where a call goes. Badging it would tell an
	 * operator their calls are being chased when they are not.
	 */
	it("says nothing for a ladder that is switched off", () => {
		expect(
			followMeSummary({ ...LADDER, enabled: false } as ExtensionRow["followMe"]),
		).toBeUndefined();
	});

	it("counts the rungs of an active ladder", () => {
		expect(followMeSummary(LADDER)).toBe("Follow me: 2");
	});

	/** On, with nothing to ring — the one case where the badge is a warning rather than a fact. */
	it("names the empty active ladder rather than showing a zero", () => {
		expect(followMeSummary({ enabled: true, targets: [] })).toBe("Follow me: no targets");
	});
});
