import { describe, expect, it } from "bun:test";
import {
	AUDIT_ACTOR_TYPE_LABELS,
	auditActorRef,
	auditFieldChanges,
	auditResourceLabel,
	auditValueText,
	shortId,
	splitAuditAction,
} from "./audit-format";
import { AUDIT_ACTOR_TYPES } from "./contracts";
import type { AuditLogEntryRow } from "./contracts";

/**
 * The change ledger is the one surface in this app whose whole value is that it is faithful, so
 * what is tested here is the places a renderer could quietly lose a fact: a column that exists on
 * only one side of a diff, a stored `null` that means something different from an absent key, and
 * the two actor principals the server deliberately keeps apart.
 */

function entry(overrides: Partial<AuditLogEntryRow> = {}): AuditLogEntryRow {
	return {
		id: "0193f2aa-0000-7000-8000-000000000001",
		organizationId: "0193f2aa-0000-7000-8000-0000000000ff",
		actorType: "user",
		actorUserId: "0193f2aa-0000-7000-8000-00000000000a",
		actorRef: null,
		action: "extension.update",
		resourceType: "extension",
		resourceRef: "0193f2aa-0000-7000-8000-00000000000b",
		before: null,
		after: null,
		ipAddress: null,
		userAgent: null,
		requestId: null,
		occurredAt: "2026-08-05T12:00:00.000Z",
		createdAt: "2026-08-05T12:00:00.000Z",
		...overrides,
	};
}

describe("AUDIT_ACTOR_TYPE_LABELS", () => {
	it("names every actor type the column can hold", () => {
		for (const actorType of AUDIT_ACTOR_TYPES) {
			expect(AUDIT_ACTOR_TYPE_LABELS[actorType].length).toBeGreaterThan(0);
		}
	});
});

describe("auditActorRef", () => {
	/**
	 * A person is `actor_user_id` with a NULL `actor_ref`; an API key or a service is the reverse.
	 * Collapsing them would let a row claim a service was a person.
	 */
	it("returns whichever principal the row actually carries", () => {
		expect(auditActorRef(entry())).toBe("0193f2aa-0000-7000-8000-00000000000a");
		expect(
			auditActorRef(entry({ actorType: "api-key", actorUserId: null, actorRef: "key_01H9" })),
		).toBe("key_01H9");
	});

	/** `system` legitimately has neither: a migration has no principal to name. */
	it("has no answer for the system actor", () => {
		expect(
			auditActorRef(entry({ actorType: "system", actorUserId: null, actorRef: null })),
		).toBeNull();
	});
});

describe("splitAuditAction", () => {
	it("splits a dotted verb into the entity and what happened to it", () => {
		expect(splitAuditAction("extension.update")).toEqual({ entity: "extension", verb: "update" });
		expect(splitAuditAction("org-setting.create")).toEqual({
			entity: "org-setting",
			verb: "create",
		});
	});

	/**
	 * The DTO's pattern guarantees a dot for anything the FILTER accepts, but a row is whatever the
	 * writer stored — and dropping a malformed action would hide exactly the entry somebody is
	 * hunting for.
	 */
	it("keeps an action with no dot rather than discarding it", () => {
		expect(splitAuditAction("purge")).toEqual({ entity: "", verb: "purge" });
	});
});

describe("auditResourceLabel", () => {
	it("reads a table name as a phrase without renaming it", () => {
		expect(auditResourceLabel("org_setting")).toBe("org setting");
		expect(auditResourceLabel("extension")).toBe("extension");
		expect(auditResourceLabel("sip_acl_entry")).toBe("sip acl entry");
	});
});

describe("shortId", () => {
	it("shortens a uuid for scanning and leaves a short value alone", () => {
		expect(shortId("0193f2aa-0000-7000-8000-00000000000a")).toBe("0193f2aa…000a");
		expect(shortId("key_01H9")).toBe("key_01H9");
	});
});

describe("auditFieldChanges", () => {
	it("pairs the two sides of an update", () => {
		expect(
			auditFieldChanges(entry({ before: { label: "Reception" }, after: { label: "Front desk" } })),
		).toEqual([{ field: "label", before: "Reception", after: "Front desk" }]);
	});

	/**
	 * A create has no `before` and a delete has no `after`. The absent side must stay absent rather
	 * than becoming `null`, because `null` is a value a column can genuinely have been set to.
	 */
	it("keeps a create and a delete one-sided", () => {
		expect(auditFieldChanges(entry({ before: null, after: { label: "Reception" } }))).toEqual([
			{ field: "label", before: undefined, after: "Reception" },
		]);
		expect(auditFieldChanges(entry({ before: { label: "Reception" }, after: null }))).toEqual([
			{ field: "label", before: "Reception", after: undefined },
		]);
	});

	/** A column added on one side only is still a change, and must not be dropped. */
	it("takes the union of both sides", () => {
		const changes = auditFieldChanges(
			entry({ before: { label: "Reception" }, after: { label: "Front desk", enabled: false } }),
		);
		expect(changes.map((change) => change.field)).toEqual(["label", "enabled"]);
	});

	/**
	 * A secret's VALUE never entered the table; its NAME appears on both sides, so a rotation stays
	 * auditable without the key being in the ledger. Nothing here has to redact anything.
	 */
	it("shows a rotated secret as a change with no values", () => {
		expect(
			auditFieldChanges(entry({ before: { sipSecretRef: null }, after: { sipSecretRef: null } })),
		).toEqual([{ field: "sipSecretRef", before: null, after: null }]);
	});

	it("has nothing to show for an entry with neither side", () => {
		expect(auditFieldChanges(entry())).toEqual([]);
	});
});

describe("auditValueText", () => {
	/**
	 * The two absences are different facts and must not read alike: an absent key means this entry
	 * does not describe that side, and a stored `null` means the column was set to nothing.
	 */
	it("keeps an absent column and a null value apart", () => {
		expect(auditValueText(undefined)).toBe("—");
		expect(auditValueText(null)).toBe("null");
	});

	it("shows a string as itself and everything else as JSON", () => {
		expect(auditValueText("Reception")).toBe("Reception");
		expect(auditValueText(42)).toBe("42");
		expect(auditValueText(false)).toBe("false");
		expect(auditValueText({ lotId: "abc" })).toBe('{"lotId":"abc"}');
	});
});
