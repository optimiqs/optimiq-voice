import { cfgValue, renderSettingsAsCfg, sortedEntries } from "../format";
import type { RenderContext } from "../render-context";
import type { VendorTemplate } from "../template";

/**
 * Softphones — a JSON account payload, and what a QR code should actually encode.
 *
 * ## There is no cross-vendor QR standard, and the obvious guess is wrong
 *
 * The three clients that matter each have their own mechanism:
 *
 * | Client | QR / deep link | What it fetches |
 * |---|---|---|
 * | Acrobits (Groundwire, Cloud Softphone) | `csc:user:password@CLOUDID` | an `<account>` XML document |
 * | Zoiper | an **HTTPS URL** | an `<options><accounts><account>` XML document |
 * | Linphone | an **HTTPS URL**, optionally wrapped as `linphone-config:` | an lpconfig `<config><section><entry>` document |
 *
 * The tempting shortcut — encode `sip:user:password@host` in a QR — **does not provision any of
 * them**. All three treat a bare `sip:` URI as a *dial* instruction: scanning it places a call. So
 * the QR here encodes the **payload URL**, which is the model Zoiper and Linphone already use and
 * the only one that degrades sensibly (a client that does not recognise it shows a link a human can
 * open).
 *
 * The `sip:` URI is still in the payload, labelled for what it is: the string somebody types or
 * pastes when entering an account by hand. That is a genuinely useful field — it is what an
 * administrator reads out when a desk-phone template has failed them — and it is not a provisioning
 * mechanism.
 *
 * ## What is deliberately not built yet
 *
 * Per-client documents: the Acrobits `<account>` XML (which also needs a Cloud Softphone id this
 * product does not have), the Zoiper `<options>` XML, and the Linphone lpconfig `<config>`. Each is
 * a template of its own with its own id, and each is a follow-up. Emitting one of them under the
 * name "softphone" would be wrong for the other two thirds of users.
 *
 * ## The payload is a credential
 *
 * It contains SIP passwords, and so does the URL that returns it. The admin UI treats the QR
 * exactly as it treats the provisioning URL — revealed deliberately, warned about, rotatable —
 * because a screenshot of it in a chat thread is a working SIP account.
 */

/**
 * `sip:user:password@host:port;transport=…`, percent-encoded.
 *
 * For MANUAL ENTRY, not for provisioning — see the class comment. The user and password sit in the
 * userinfo component where `@`, `:` and `;` would each end it early, and `encodeURIComponent` is
 * stricter than RFC 3261 requires. That is the right direction: an over-encoded userinfo is decoded
 * correctly by every client, an under-encoded one is not.
 */
export function sipAccountUri(input: {
	readonly user: string;
	readonly password: string;
	readonly host: string;
	readonly port: number;
	readonly transport: string;
}): string {
	const user = encodeURIComponent(input.user);
	const password = encodeURIComponent(input.password);
	const port = input.port === 5060 ? "" : `:${input.port}`;
	return `sip:${user}:${password}@${input.host}${port};transport=${input.transport}`;
}

export const SOFTPHONE_TEMPLATE: VendorTemplate = {
	id: "0192a1c0-0000-7000-8000-000000000006",
	vendor: "softphone",
	name: "Softphone (JSON account payload; QR encodes the payload URL)",
	models: ["GROUNDWIRE", "ACROBITS", "ZOIPER", "LINPHONE", "BRIA", "GENERIC"],
	defaults: {},
	contentType: "application/json; charset=utf-8",
	filename: (macAddress) => `${macAddress}.json`,
	render: (context: RenderContext): string =>
		`${JSON.stringify(softphonePayload(context), null, "\t")}\n`,
	sources: [
		"Acrobits documentation — `csc:username:password@CLOUDID` initial-screen scheme; Account XML (`<account>` with `username` / `password` / `host` / `transport` / `expires`); call URI schemes (`sip:`, `groundwire:`) are DIAL instructions, not provisioning",
		"Zoiper OEM token-based provisioning — QR encodes an HTTPS URL; the endpoint returns `<options><accounts><account>` XML",
		'Linphone / liblinphone — remote provisioning is an HTTP(S) URL returning lpconfig `<config><section name="proxy_0"><entry …>` XML; the `linphone-config:` scheme wraps that URL',
		"RFC 3261 §19.1 — SIP URI syntax, userinfo component and the `transport` URI parameter",
	],
	caveats: [
		"A bare `sip:` URI in a QR code places a CALL in Acrobits, Zoiper and Linphone — it does not provision any of them. The QR target is the payload URL for that reason.",
		"Per-client provisioning documents (Acrobits `<account>` XML, Zoiper `<options>` XML, Linphone lpconfig) are follow-ups, one template each.",
		"The payload and its URL are credentials: they contain SIP passwords.",
	],
};

export interface SoftphoneAccountPayload {
	readonly line: number;
	readonly label: string;
	readonly displayName: string;
	readonly username: string;
	readonly authUsername: string;
	readonly password: string;
	readonly domain: string;
	readonly server: string;
	readonly port: number;
	readonly transport: string;
	readonly registerExpiresSeconds: number;
	readonly voicemailNumber: string | null;
	/** For MANUAL entry. Scanning this as a QR code places a call; it does not provision. */
	readonly sipUri: string;
}

export interface SoftphonePayload {
	readonly version: 1;
	readonly device: {
		readonly id: string;
		readonly macAddress: string;
		readonly label: string | null;
		readonly vendor: string;
		readonly model: string | null;
	};
	readonly accounts: readonly SoftphoneAccountPayload[];
	readonly settings: Readonly<Record<string, string | number | boolean>>;
	/**
	 * What a QR code should encode, and a plain statement of why.
	 *
	 * Carried IN the payload rather than left to each client to work out, so the admin UI, a future
	 * mobile app and a support engineer reading a curl output all get the same answer.
	 */
	readonly qr: {
		readonly url: string | null;
		readonly note: string;
	};
	readonly renderedAt: string;
}

const QR_NOTE =
	"Encode this URL in the QR code. A bare sip: URI would place a call rather than " +
	"provision — Acrobits, Zoiper and Linphone all treat sip: as a dial instruction. " +
	"Treat this URL as a credential: it returns SIP passwords.";

/**
 * The structured payload, shared by the render endpoint and the admin reveal.
 *
 * One function rather than two because the two must not drift: an administrator scanning a QR from
 * the admin UI and a client fetching `/provision/<token>/payload` have to end up with the same
 * account, or the support conversation becomes "which one did you use?".
 */
export function softphonePayload(context: RenderContext): SoftphonePayload {
	return {
		version: 1,
		device: {
			id: context.deviceId,
			macAddress: context.macAddress,
			label: context.label ?? null,
			vendor: context.vendor,
			model: context.model ?? null,
		},
		accounts: context.lines.map((line) => ({
			line: line.lineNumber,
			label: line.label ?? line.registerUser,
			displayName: line.displayName,
			username: line.registerUser,
			authUsername: line.authUser,
			password: line.password,
			domain: context.sipDomain,
			server: line.serverAddress,
			port: line.serverPort,
			transport: line.transport,
			registerExpiresSeconds: line.registerExpiresSeconds,
			voicemailNumber: line.voicemailNumber ?? null,
			sipUri: sipAccountUri({
				user: line.registerUser,
				password: line.password,
				host: line.serverAddress,
				port: line.serverPort,
				transport: line.transport,
			}),
		})),
		settings: Object.fromEntries(sortedEntries(context.settings)),
		qr: { url: context.payloadUrl ?? null, note: QR_NOTE },
		renderedAt: context.renderedAt.toISOString(),
	};
}

/**
 * The fallback for a device whose vendor is `generic`.
 *
 * A plain `key = value` dump of everything the cascade resolved plus the accounts — useless to a
 * phone and exactly right for the two cases it exists for: an administrator recording a device this
 * catalogue does not cover, and a support engineer who wants to see what the cascade produced
 * without reading five vendors' syntaxes. It is not a template pretending to work; the first three
 * lines of its output say so, and the UI says so beside the vendor picker.
 */
export const GENERIC_TEMPLATE: VendorTemplate = {
	id: "0192a1c0-0000-7000-8000-000000000007",
	vendor: "generic",
	name: "Generic (diagnostic key/value dump — not a phone format)",
	models: [],
	defaults: {},
	contentType: "text/plain; charset=utf-8",
	filename: (macAddress) => `${macAddress}.txt`,
	render: (context: RenderContext): string => {
		const accounts = context.lines.flatMap((line) => [
			`account.${line.lineNumber}.display_name = ${cfgValue(line.displayName)}`,
			`account.${line.lineNumber}.user = ${cfgValue(line.registerUser)}`,
			`account.${line.lineNumber}.auth_user = ${cfgValue(line.authUser)}`,
			`account.${line.lineNumber}.password = ${cfgValue(line.password)}`,
			`account.${line.lineNumber}.server = ${cfgValue(line.serverAddress)}`,
			`account.${line.lineNumber}.port = ${line.serverPort}`,
			`account.${line.lineNumber}.transport = ${cfgValue(line.transport)}`,
			`account.${line.lineNumber}.expires = ${line.registerExpiresSeconds}`,
		]);
		const keys = context.keys.map(
			(key) =>
				`key.${key.category}.${key.keyIndex} = ${key.keyType}${key.value === undefined ? "" : ` ${cfgValue(key.value)}`}`,
		);
		return `${[
			`# Optimiq Voice diagnostic dump — ${context.macAddress}`,
			`# rendered ${context.renderedAt.toISOString()}`,
			"# This is NOT a vendor provisioning format. No phone will accept it.",
			"",
			...accounts,
			"",
			...keys,
		].join("\n")}${renderSettingsAsCfg(context.settings)}\n`;
	},
	sources: [],
	caveats: ["Not a phone format. A device left on `generic` is not provisionable."],
};
