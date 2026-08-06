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
