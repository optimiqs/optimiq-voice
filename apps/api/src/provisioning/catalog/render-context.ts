import type {
	DeviceKeyCategory,
	DeviceKeyType,
	DeviceVendor,
	ProvisioningSettings,
	SipTransport,
} from "@optimiq-voice/pbx-db";

/**
 * Everything a vendor template is allowed to see.
 *
 * The templates are pure functions of this and nothing else — no database handle, no environment,
 * no clock. That is what makes them testable against a golden output, and it is what stops a
 * template from quietly becoming the place a query lives.
 */

/** One SIP account, fully resolved: no NULLs, no "look this up yourself". */
export interface RenderLine {
	readonly lineNumber: number;
	/** What appears on the phone's screen for this account. */
	readonly displayName: string;
	/** The SIP user part — the extension number. */
	readonly registerUser: string;
	/** The auth id. Defaults to `registerUser` when the line does not override it. */
	readonly authUser: string;
	readonly password: string;
	readonly serverAddress: string;
	readonly serverPort: number;
	readonly transport: SipTransport;
	readonly outboundProxy: string | undefined;
	readonly registerExpiresSeconds: number;
	readonly sharedLine: boolean;
	/** The key's caption, when the administrator set one. */
	readonly label: string | undefined;
	/** The voicemail number this account subscribes to for MWI, when the extension has a box. */
	readonly voicemailNumber: string | undefined;
}

/** One programmable key, resolved through the profile→device cascade. */
export interface RenderKey {
	readonly category: DeviceKeyCategory;
	readonly keyIndex: number;
	readonly keyType: DeviceKeyType;
	readonly value: string | undefined;
	readonly label: string | undefined;
	readonly lineNumber: number;
}

/**
 * A handset's dispatchable location, resolved.
 *
 * Both halves are carried, not just the formatted line: `addressId` is what an admin UI links to,
 * `detail` is the part the person at the desk wrote and the part they will want to correct, and
 * `validated` is the honest statement that the address behind it has (or has not) been checked by
 * the upstream provider. A single string would make all three unreadable to a client.
 */
export interface DispatchableLocation {
	readonly addressId: string | null;
	/** Every part on one line, address detail then desk detail. Never empty when this exists. */
	readonly formatted: string;
	/** `device.emergency_location_detail` on its own — "Floor 3, desk by the window". */
	readonly detail: string | null;
	/** Whether the upstream provider validated the address. `false` is shown, never suppressed. */
	readonly validated: boolean;
}

export interface RenderContext {
	readonly organizationId: string;
	readonly deviceId: string;
	/** Twelve lower-case hex characters. */
	readonly macAddress: string;
	readonly vendor: DeviceVendor;
	/** The model as the administrator recorded it, or `undefined` for a family-wide render. */
	readonly model: string | undefined;
	readonly label: string | undefined;
	readonly lines: readonly RenderLine[];
	readonly keys: readonly RenderKey[];
	/**
	 * The resolved settings cascade — what a template merges over its own output.
	 *
	 * Already flattened: the template never sees which level a value came from, because a template
	 * that could would eventually start branching on it.
	 */
	readonly settings: ProvisioningSettings;
	/** The SIP domain accounts register into. Used where a vendor wants a full AOR. */
	readonly sipDomain: string;
	/**
	 * Where this handset physically is — the RAY BAUM'S dispatchable location, already formatted.
	 *
	 * `undefined` means the device carries no location of its own, which is the ordinary state: the
	 * dispatch then falls back to the extension's number and the DID, as it always did. No desk-phone
	 * template consumes this yet — a vendor `.cfg` has nowhere to put a street address — and it is in
	 * the context because the SOFTPHONE payload does: a browser client is the one endpoint that can
	 * show a user which address a 911 call from it will produce, which is the check §9.8 assumes
	 * somebody has made and which nothing in this product previously made possible.
	 */
	readonly dispatchableLocation: DispatchableLocation | undefined;
	/**
	 * The absolute URL this configuration was fetched from, when the deployment knows its own
	 * public base.
	 *
	 * Only the softphone payload uses it, and it needs it for a specific reason: the thing a QR
	 * code should encode for Zoiper and Linphone is a provisioning URL, not the credentials. It is
	 * `undefined` when `PROVISION_BASE_URL` is unset, which is a deployment that cannot hand out a
	 * provisioning link at all.
	 */
	readonly payloadUrl: string | undefined;
	/** When the configuration was produced. Rendered into a header comment for support. */
	readonly renderedAt: Date;
}

/** What a template produces. */
export interface RenderedConfig {
	readonly body: string;
	readonly contentType: string;
	/** The name a phone would have fetched this under, e.g. `001565abcdef.cfg`. */
	readonly filename: string;
}
