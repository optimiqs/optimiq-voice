import { extension } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Extensions — the tenant's internal endpoints, and the entity most other rows point at.
 *
 * No destination trio of its own: an extension's forwarding is expressed as dialable strings
 * (`forward_busy_destination`), not as the column trio, because a forward target is frequently a
 * mobile number rather than a row in this database. The compiler resolves those strings against
 * the internal number table and reports `unresolvable-forward` when they go nowhere.
 *
 * `destinationType: "extension"` is what makes a delete safe: every ring-group member, IVR option
 * and DID that names this extension is found by the reverse scan and returned in the 409.
 */
export const EXTENSION_RESOURCE: PbxResource = {
	kind: "extension",
	tableName: "extension",
	table: extension,
	searchColumns: [extension.number, extension.label],
	// `number` is what an admin scans for; `id` breaks its ties so paging cannot repeat a row.
	orderBy: [extension.number, extension.id],
	enabledColumn: extension.enabled,
	destinations: [],
	destinationType: "extension",
	/**
	 * The SIP credential columns, which no reader of this API has any business receiving.
	 *
	 * `sipPasswordHa1` is `MD5(user:realm:password)`. It is not a password "hash" in the sense that
	 * makes a leak survivable — it IS the credential the registrar compares against, so anyone
	 * holding it can answer a digest challenge without ever recovering the password, and can also
	 * grind it offline at MD5 speed if they want the password too. It was being returned in full
	 * from every extension list page.
	 *
	 * `sipSecretRef` is a handle rather than the secret itself, which is exactly why it is worth
	 * withholding: it is the address an attacker who has reached the secret manager needs in order
	 * to know WHICH secret belongs to this extension. Publishing the index of a vault to every
	 * reader of the extension list gives up the one thing the indirection was bought for.
	 *
	 * Both stay writable — `createExtensionDto` still requires `sipSecretRef` and still accepts a
	 * pre-computed HA1 — because setting a credential and reading one back are different rights.
	 * `apps/web`'s edit form sends the reference only when the operator retypes it; an absent key on
	 * a PATCH leaves the stored value alone.
	 */
	secretColumns: ["sipSecretRef", "sipPasswordHa1"],
};
