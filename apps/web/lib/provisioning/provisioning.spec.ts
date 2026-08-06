import { describe, expect, it } from "bun:test";
import { PROVISIONING_CHILDREN, PROVISIONING_RESOURCES } from "./client";
import {
	DEVICE_KEY_CATEGORIES,
	DEVICE_KEY_TYPES,
	DEVICE_VENDORS,
	KEY_CATEGORY_LABELS,
	KEY_TYPE_LABELS,
	VENDOR_LABELS,
	formatMacAddress,
	normalizeMacAddress,
} from "./contracts";
import {
	deviceFormSchema,
	deviceKeyFormSchema,
	deviceLineFormSchema,
	deviceProfileFormSchema,
	macAddressField,
	settingsTextField,
	settingsToText,
} from "./schemas";

/**
 * The mirrored contract, held against the constraints it claims to mirror.
 *
 * These are the assertions that catch the drift this file exists to make survivable: a vendor added
 * to the schema without a label, a key type the picker cannot name, a MAC normalization that
 * disagrees with the server's, and a settings editor that would send a shape the API refuses.
 */

describe("the mirrored vocabularies", () => {
	it("names every vendor the picker can offer", () => {
		for (const vendor of DEVICE_VENDORS) {
			expect(VENDOR_LABELS[vendor], vendor).toBeTruthy();
		}
		expect(Object.keys(VENDOR_LABELS).sort()).toEqual([...DEVICE_VENDORS].sort());
	});

	it("names every key type and category", () => {
		expect(Object.keys(KEY_TYPE_LABELS).sort()).toEqual([...DEVICE_KEY_TYPES].sort());
		expect(Object.keys(KEY_CATEGORY_LABELS).sort()).toEqual([...DEVICE_KEY_CATEGORIES].sort());
	});
});

describe("MAC handling", () => {
	it("normalizes every spelling to the one the server stores", () => {
		for (const spelling of [
			"00:15:65:AB:CD:EF",
			"00-15-65-ab-cd-ef",
			"0015.65ab.cdef",
			"001565ABCDEF",
		]) {
			expect(normalizeMacAddress(spelling)).toBe("001565abcdef");
		}
	});

	it("refuses anything that is not twelve hex characters", () => {
		for (const bad of ["", "001565abcde", "zz1565abcdef"]) {
			expect(normalizeMacAddress(bad)).toBeUndefined();
		}
	});

	it("round-trips through the display form without changing the stored value", () => {
		expect(formatMacAddress("001565abcdef")).toBe("00:15:65:AB:CD:EF");
		expect(normalizeMacAddress(formatMacAddress("001565abcdef"))).toBe("001565abcdef");
	});

	it("leaves an unrecognized value alone rather than mangling it for display", () => {
		expect(formatMacAddress("pending")).toBe("pending");
	});
});

describe("the descriptors", () => {
	it("marks nothing as a routing input, because no device table is one", () => {
		for (const resource of Object.values(PROVISIONING_RESOURCES)) {
			expect(resource.affectsRouting, resource.key).toBe(false);
		}
		for (const child of Object.values(PROVISIONING_CHILDREN)) {
			expect(child.affectsRouting, child.key).toBe(false);
		}
	});

	it("guards profiles with the same grants as devices, never weaker ones", () => {
		expect(PROVISIONING_RESOURCES.deviceProfiles.permissions).toEqual(
			PROVISIONING_RESOURCES.devices.permissions,
		);
	});

	it("names a device by its label and its formatted MAC", () => {
		const row = { macAddress: "001565abcdef", label: "Reception" } as never;
		expect(PROVISIONING_RESOURCES.devices.displayName(row)).toBe("Reception · 00:15:65:AB:CD:EF");
	});

	it("falls back to the MAC when a device has no label", () => {
		const row = { macAddress: "001565abcdef", label: null } as never;
		expect(PROVISIONING_RESOURCES.devices.displayName(row)).toBe("00:15:65:AB:CD:EF");
	});
});

describe("the MAC form field", () => {
	it("accepts what an administrator pastes and yields what the server stores", () => {
		expect(macAddressField.parse("00:15:65:AB:CD:EF")).toBe("001565abcdef");
	});

	it("refuses a malformed address before a round trip", () => {
		expect(macAddressField.safeParse("nope").success).toBe(false);
	});
});

describe("the settings editor", () => {
	it("parses key = value lines into the bag the API accepts", () => {
		expect(settingsTextField.parse("a.b = 1\nc.d = hello")).toEqual({ "a.b": "1", "c.d": "hello" });
	});

	it("accepts a colon separator and a spaced key, because that is Fanvil's parameter shape", () => {
		expect(settingsTextField.parse("SIP1 Register TTL : 3600")).toEqual({
			"SIP1 Register TTL": "3600",
		});
	});

	it("skips blank lines and comments so a pasted vendor block works verbatim", () => {
		expect(settingsTextField.parse("# a comment\n\n; another\na.b = 1")).toEqual({ "a.b": "1" });
	});

	it("refuses a line that is not a pair rather than dropping it", () => {
		expect(settingsTextField.safeParse("this is not a setting").success).toBe(false);
	});

	it("refuses a key that would break out of the syntax it is written into", () => {
		expect(settingsTextField.safeParse("bad<key> = 1").success).toBe(false);
	});

	it("round-trips a stored bag back into sorted editable text", () => {
		expect(settingsToText({ zeta: 1, alpha: "x" })).toBe("alpha = x\nzeta = 1");
		expect(settingsToText(null)).toBe("");
	});
});

describe("the form schemas", () => {
	it("clears an emptied optional text field to null rather than to an empty string", () => {
		const parsed = deviceFormSchema.parse({
			macAddress: "001565abcdef",
			vendor: "yealink",
			model: "",
			label: "",
			deviceProfileId: "",
			settings: "",
			enabled: true,
		});
		expect(parsed.model).toBeNull();
		expect(parsed.label).toBeNull();
		expect(parsed.deviceProfileId).toBeNull();
	});

	it("refuses a vendor outside the catalogue", () => {
		expect(
			deviceProfileFormSchema.safeParse({
				name: "x",
				description: "",
				vendor: "cisco",
				model: "",
				settings: "",
				enabled: true,
			}).success,
		).toBe(false);
	});

	it("bounds a line number to something a phone could have", () => {
		const base = { extensionId: "", label: "", sharedLine: false, enabled: true };
		expect(deviceLineFormSchema.safeParse({ ...base, lineNumber: "1" }).success).toBe(true);
		expect(deviceLineFormSchema.safeParse({ ...base, lineNumber: "0" }).success).toBe(false);
		expect(deviceLineFormSchema.safeParse({ ...base, lineNumber: "999" }).success).toBe(false);
	});

	it("accepts the key vocabulary and refuses anything else", () => {
		const base = {
			category: "memory",
			keyIndex: "1",
			value: "1002",
			label: "Ben",
			lineNumber: "1",
		};
		expect(deviceKeyFormSchema.safeParse({ ...base, keyType: "blf" }).success).toBe(true);
		expect(deviceKeyFormSchema.safeParse({ ...base, keyType: "wormhole" }).success).toBe(false);
	});
});
