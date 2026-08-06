/**
 * MAC addresses, normalized once.
 *
 * A MAC arrives written five ways — `00:15:65:AB:CD:EF`, `00-15-65-ab-cd-ef`, `0015.65ab.cdef`,
 * `001565ABCDEF`, and whatever an administrator's clipboard did to it — and all five are the same
 * address. Storing them verbatim would make `device_organization_mac_address_key` enforce
 * uniqueness over *spellings*, so the same phone could be entered twice and the second entry would
 * silently win the provisioning race.
 *
 * So the storage form is one form: twelve lower-case hex characters, no separators. That is also
 * exactly `macAddressSchema` in `@optimiq-voice/events` — the provisioning events carry a MAC and
 * the shapes must agree — and it is the form Yealink, Poly, Grandstream, Fanvil and Snom all use in
 * their per-MAC provisioning filenames.
 *
 * Display is the caller's job and happens at the edge: {@link formatMacAddress} produces the
 * colon-separated form a human reads off the sticker on the bottom of a phone. It is deliberately
 * NOT what is stored, because a display format is a preference and a key is not.
 */

/** Twelve lower-case hex characters. What the column holds and what the events schema accepts. */
export const NORMALIZED_MAC_PATTERN = /^[0-9a-f]{12}$/u;

/** Every separator a vendor, a label printer or a spreadsheet has ever put in a MAC. */
const SEPARATORS = /[\s:.–—-]/gu;

/**
 * Normalizes a MAC to storage form, or `undefined` when the input is not one.
 *
 * Returns `undefined` rather than throwing so the two callers can each say what they mean: the DTO
 * turns it into a field-addressed 400, and the render path turns it into a rejection reason.
 */
export function normalizeMacAddress(value: string): string | undefined {
	const stripped = value.replace(SEPARATORS, "").toLowerCase();
	return NORMALIZED_MAC_PATTERN.test(stripped) ? stripped : undefined;
}

/** `001565abcdef` -> `00:15:65:AB:CD:EF`. For display only; never write this to the database. */
export function formatMacAddress(normalized: string): string {
	if (!NORMALIZED_MAC_PATTERN.test(normalized)) {
		return normalized;
	}
	return (normalized.match(/.{2}/gu) ?? []).join(":").toUpperCase();
}

/**
 * The OUI — the first three octets, which identify the manufacturer.
 *
 * Not used to *decide* a vendor (an administrator states the vendor, because a Poly-branded OEM
 * board in somebody else's chassis would otherwise be provisioned with the wrong template) but
 * exposed so the UI can show it and so a future "did you mean Yealink?" hint has something to read.
 */
export function macOui(normalized: string): string | undefined {
	return NORMALIZED_MAC_PATTERN.test(normalized) ? normalized.slice(0, 6) : undefined;
}
