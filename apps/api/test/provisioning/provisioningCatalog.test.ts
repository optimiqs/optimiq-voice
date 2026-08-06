import { expect } from "chai";
import { DEVICE_VENDORS } from "@optimiq-voice/pbx-db";
import { explainSettings, resolveSettings } from "../../src/provisioning/catalog/cascade";
import {
	CATALOG_VENDORS,
	catalogEntries,
	modelDefaults,
	templateCoversModel,
	templateFor,
	VENDOR_TEMPLATES,
} from "../../src/provisioning/catalog/catalog";
import {
	cfgValue,
	renderSettingsAsCfg,
	sortedEntries,
	xmlEscape,
} from "../../src/provisioning/catalog/format";
import { formatMacAddress, macOui, normalizeMacAddress } from "../../src/provisioning/catalog/mac";
import { renderWith } from "../../src/provisioning/catalog/template";
import { fanvilVersionFor } from "../../src/provisioning/catalog/templates/fanvil";
import { clampMinutes } from "../../src/provisioning/catalog/templates/grandstream";
import {
	sipAccountUri,
	softphonePayload,
} from "../../src/provisioning/catalog/templates/softphone";
import { yealinkKeyNamespace } from "../../src/provisioning/catalog/templates/yealink";
import type { RenderContext } from "../../src/provisioning/catalog/render-context";

/**
 * The catalogue, its cascade and its five renderers — checked without a database, a broker or a
 * phone.
 *
 * These are the assertions that CAN be made in this repository. The ones that cannot — "does a
 * Yealink T54W accept this file?" — are recorded in `plans/reference/device-provisioning-formats.md`
 * and in each template's `caveats`, because a test suite that implied otherwise would be worse than
 * no suite at all.
 *
 * The template assertions are golden-ish rather than byte-for-byte fixtures: they pin the lines a
 * phone cannot work without (the mandatory banner, the credential quartet, the transport spelling)
 * and deliberately do not pin the whole document, so adding a parameter is an ordinary edit rather
 * than a fixture rewrite that nobody reads.
 */

function context(overrides: Partial<RenderContext> = {}): RenderContext {
	return {
		organizationId: "019fd3c2-1111-7000-8000-000000000001",
		deviceId: "019fd3c2-2222-7000-8000-000000000002",
		macAddress: "001565abcdef",
		vendor: "yealink",
		model: "T54W",
		label: "Reception",
		lines: [
			{
				lineNumber: 1,
				displayName: "Alice Nguyen",
				registerUser: "1001",
				authUser: "1001",
				password: "s3cret-derived",
				serverAddress: "pbx.example.com",
				serverPort: 5060,
				transport: "udp",
				outboundProxy: undefined,
				registerExpiresSeconds: 3600,
				sharedLine: false,
				label: "Reception",
				voicemailNumber: "1001",
			},
		],
		keys: [
			{
				category: "memory",
				keyIndex: 1,
				keyType: "blf",
				value: "1002",
				label: "Ben",
				lineNumber: 1,
			},
			{
				category: "memory",
				keyIndex: 2,
				keyType: "speed-dial",
				value: "+12125550100",
				label: "Support",
				lineNumber: 1,
			},
		],
		settings: {},
		sipDomain: "pbx.example.com",
		payloadUrl: "https://pbx.example.com/provision/ref.secret/payload",
		renderedAt: new Date("2026-08-06T12:00:00.000Z"),
		...overrides,
	};
}

describe("MAC normalization", () => {
	it("accepts every spelling of one address and stores one", () => {
		for (const spelling of [
			"00:15:65:AB:CD:EF",
			"00-15-65-ab-cd-ef",
			"0015.65ab.cdef",
			"001565ABCDEF",
			" 00 15 65 ab cd ef ",
		]) {
			expect(normalizeMacAddress(spelling), spelling).to.equal("001565abcdef");
		}
	});

	it("refuses anything that is not twelve hex characters", () => {
		for (const bad of ["", "001565abcde", "001565abcdeff", "zz1565abcdef", "00:15:65:AB:CD"]) {
			expect(normalizeMacAddress(bad), bad).to.equal(undefined);
		}
	});

	it("formats for display without changing what is stored", () => {
		expect(formatMacAddress("001565abcdef")).to.equal("00:15:65:AB:CD:EF");
		expect(normalizeMacAddress(formatMacAddress("001565abcdef"))).to.equal("001565abcdef");
	});

	it("exposes the OUI", () => {
		expect(macOui("001565abcdef")).to.equal("001565");
		expect(macOui("nope")).to.equal(undefined);
	});
});

describe("the settings cascade", () => {
	it("resolves model < organization < profile < device", () => {
		const resolved = resolveSettings({
			model: { timezone: "UTC", logLevel: 3, wallpaper: "default" },
			organization: { timezone: "Europe/Dublin", ntp: "pool.ntp.org" },
			profile: { timezone: "Europe/London" },
			device: { logLevel: 6 },
		});
		expect(resolved).to.deep.equal({
			timezone: "Europe/London",
			logLevel: 6,
			wallpaper: "default",
			ntp: "pool.ntp.org",
		});
	});

	it("lets a device override a profile, which is the case the UI exists to make debuggable", () => {
		const resolved = resolveSettings({
			profile: { "features.dnd.enable": 1 },
			device: { "features.dnd.enable": 0 },
		});
		expect(resolved["features.dnd.enable"]).to.equal(0);
	});

	it("ignores a level that is absent or null", () => {
		expect(
			resolveSettings({ model: null, organization: undefined, device: { a: 1 } }),
		).to.deep.equal({ a: 1 });
	});

	it("reports provenance nearest-first so the UI can answer 'why is this value what it is?'", () => {
		const explained = explainSettings({
			model: { timezone: "UTC" },
			organization: { timezone: "Europe/Dublin" },
			profile: { timezone: "Europe/London" },
		});
		expect(explained).to.have.length(1);
		expect(explained[0]?.level).to.equal("profile");
		expect(explained[0]?.value).to.equal("Europe/London");
		expect(explained[0]?.overrides.map((entry) => entry.level)).to.deep.equal([
			"organization",
			"model",
		]);
	});
});

describe("format helpers", () => {
	it("escapes the five XML characters", () => {
		expect(xmlEscape(`Sales & <Marketing> "x" 'y'`)).to.equal(
			"Sales &amp; &lt;Marketing&gt; &quot;x&quot; &apos;y&apos;",
		);
	});

	it("flattens a value onto one line so a label cannot end a cfg line early", () => {
		expect(cfgValue("Sales\nMarketing")).to.equal("Sales Marketing");
		expect(cfgValue(true)).to.equal("1");
		expect(cfgValue(false)).to.equal("0");
	});

	it("sorts settings so two renders of an unchanged device are byte-identical", () => {
		const a = renderSettingsAsCfg({ zeta: 1, alpha: 2 });
		const b = renderSettingsAsCfg({ alpha: 2, zeta: 1 });
		expect(a).to.equal(b);
		expect(a.indexOf("alpha")).to.be.lessThan(a.indexOf("zeta"));
	});

	it("drops a key that would break out of the syntax it is written into", () => {
		expect(
			sortedEntries({ "ok.key": 1, "bad<key>": 2, "bad key": 3 }).map(([key]) => key),
		).to.deep.equal(["ok.key"]);
	});
});

describe("the vendor catalogue", () => {
	it("has a template for every vendor the schema knows", () => {
		for (const vendor of DEVICE_VENDORS) {
			expect(templateFor(vendor), vendor).to.not.equal(undefined);
		}
		expect(CATALOG_VENDORS).to.deep.equal(DEVICE_VENDORS);
	});

	it("gives every template a distinct, stable UUID", () => {
		const ids = VENDOR_TEMPLATES.map((template) => template.id);
		expect(new Set(ids).size).to.equal(ids.length);
		for (const id of ids) {
			expect(id, id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
		}
	});

	it("matches a model by prefix so an unlisted suffix still resolves", () => {
		const yealink = templateFor("yealink");
		expect(yealink).to.not.equal(undefined);
		expect(templateCoversModel(yealink!, "T54W")).to.equal(true);
		expect(templateCoversModel(yealink!, "t54w-a")).to.equal(true);
		expect(templateCoversModel(yealink!, "GRP2615")).to.equal(false);
	});

	it("serves caveats to the UI, because none of these has met hardware", () => {
		const entries = catalogEntries();
		const provisionable = entries.filter(
			(entry) => entry.provisionable && entry.vendor !== "softphone",
		);
		expect(provisionable).to.have.length.greaterThan(0);
		for (const entry of provisionable) {
			expect(entry.caveats.join(" "), entry.vendor).to.contain("physical hardware");
			expect(entry.sources, entry.vendor).to.have.length.greaterThan(0);
		}
	});

	it("marks generic as not provisionable", () => {
		const generic = catalogEntries().find((entry) => entry.vendor === "generic");
		expect(generic?.provisionable).to.equal(false);
	});

	it("returns model defaults from the template", () => {
		expect(modelDefaults("yealink")).to.have.property("static.auto_provision.mode");
		expect(modelDefaults("fanvil")).to.deep.equal({});
	});
});

describe("Yealink rendering", () => {
	const rendered = renderWith(templateFor("yealink")!, context());

	it("starts with the mandatory version banner", () => {
		expect(rendered.body.split("\n")[0]).to.equal("#!version:1.0.0.1");
	});

	it("names the file after the normalized MAC", () => {
		expect(rendered.filename).to.equal("001565abcdef.cfg");
	});

	it("renders the credential quartet a phone cannot register without", () => {
		expect(rendered.body).to.contain("account.1.enable = 1");
		expect(rendered.body).to.contain("account.1.auth_name = 1001");
		expect(rendered.body).to.contain("account.1.user_name = 1001");
		expect(rendered.body).to.contain("account.1.password = s3cret-derived");
		expect(rendered.body).to.contain("account.1.sip_server.1.address = pbx.example.com");
	});

	it("uses transport_type, not transport, and spells TLS as 2", () => {
		expect(rendered.body).to.contain("account.1.sip_server.1.transport_type = 0");
		expect(rendered.body).to.not.contain("account.1.sip_server.1.transport =");
		const tls = renderWith(
			templateFor("yealink")!,
			context({ lines: [{ ...context().lines[0]!, transport: "tls" }] }),
		);
		expect(tls.body).to.contain("account.1.sip_server.1.transport_type = 2");
	});

	it("uses the indexed outbound-proxy sub-object", () => {
		const proxied = renderWith(
			templateFor("yealink")!,
			context({ lines: [{ ...context().lines[0]!, outboundProxy: "sbc.example.com:5070" }] }),
		);
		expect(proxied.body).to.contain("account.1.outbound_proxy_enable = 1");
		expect(proxied.body).to.contain("account.1.outbound_proxy.1.address = sbc.example.com");
		expect(proxied.body).to.contain("account.1.outbound_proxy.1.port = 5070");
	});

	it("renders memory keys into the linekey namespace, which is the only DSS namespace V86 has", () => {
		expect(rendered.body).to.contain("linekey.1.type = 16");
		expect(rendered.body).to.contain("linekey.1.value = 1002");
		expect(rendered.body).to.contain("linekey.2.type = 13");
		expect(yealinkKeyNamespace("expansion")).to.equal("expkey");
		expect(yealinkKeyNamespace("programmable")).to.equal("programablekey");
	});

	it("renders an unmappable key type as N/A rather than a plausible-looking guess", () => {
		const dtmf = renderWith(
			templateFor("yealink")!,
			context({
				keys: [
					{
						category: "memory",
						keyIndex: 1,
						keyType: "dtmf",
						value: "*1",
						label: "X",
						lineNumber: 1,
					},
				],
			}),
		);
		expect(dtmf.body).to.contain("linekey.1.type = 0");
	});

	it("appends the resolved settings block", () => {
		const withSettings = renderWith(
			templateFor("yealink")!,
			context({ settings: { "features.dnd.enable": 1 } }),
		);
		expect(withSettings.body).to.contain("features.dnd.enable = 1");
	});
});

describe("Poly rendering", () => {
	const rendered = renderWith(templateFor("poly")!, context({ vendor: "poly", model: "VVX450" }));

	it("produces a PHONE_CONFIG document with attributes, not elements", () => {
		expect(rendered.body).to.contain("<PHONE_CONFIG>");
		expect(rendered.body).to.contain('reg.1.auth.userId="1001"');
		expect(rendered.body).to.contain('reg.1.auth.password="s3cret-derived"');
	});

	it("uses the AOR form for the registration address", () => {
		expect(rendered.body).to.contain('reg.1.address="1001@pbx.example.com"');
	});

	it("spells the transport as a WORD, which is the trap when porting the Yealink template", () => {
		expect(rendered.body).to.contain('reg.1.server.1.transport="UDPOnly"');
		expect(rendered.body).to.not.match(/reg\.1\.server\.1\.transport="\d"/u);
	});

	it("renders BLF as an attendant resource and a speed dial as an enhanced feature key", () => {
		expect(rendered.body).to.contain('attendant.reg="1"');
		expect(rendered.body).to.contain('attendant.resourceList.1.address="1002@pbx.example.com"');
		expect(rendered.body).to.contain('attendant.resourceList.1.type="normal"');
		expect(rendered.body).to.contain('feature.enhancedFeatureKeys.enabled="1"');
		expect(rendered.body).to.contain("$Tinvite$");
	});

	it("defines the EFK macro as well as binding it, so the key is not bound to nothing", () => {
		expect(rendered.body).to.contain('efk.efklist.1.mname="sd1"');
		expect(rendered.body).to.contain("efk.efklist.1.action.string=");
		expect(rendered.body).to.contain("efk.efksoftkey.1.action.string=");
	});

	it("gives an outbound proxy a port and a transport of its own", () => {
		const proxied = renderWith(
			templateFor("poly")!,
			context({
				vendor: "poly",
				lines: [{ ...context().lines[0]!, outboundProxy: "sbc.example.com:5070" }],
			}),
		);
		expect(proxied.body).to.contain('reg.1.outboundProxy.address="sbc.example.com"');
		expect(proxied.body).to.contain('reg.1.outboundProxy.port="5070"');
		expect(proxied.body).to.contain('reg.1.outboundProxy.transport="UDPOnly"');
	});

	it("does NOT claim the master manifest's filename", () => {
		expect(rendered.filename).to.equal("001565abcdef-phone.cfg");
	});
});

describe("Grandstream rendering", () => {
	const rendered = renderWith(
		templateFor("grandstream")!,
		context({ vendor: "grandstream", model: "GRP2615" }),
	);

	it("uses the gs_provision root and the alias dialect", () => {
		expect(rendered.body).to.contain('<gs_provision version="1">');
		expect(rendered.body).to.contain('<config version="2">');
		expect(rendered.body).to.not.contain("<P271>");
	});

	it("emits the validated <mac> element", () => {
		expect(rendered.body).to.contain("<mac>001565abcdef</mac>");
	});

	it("requests the filename the firmware looks for first", () => {
		expect(rendered.filename).to.equal("cfg001565abcdef.xml");
	});

	it("uses the verified alias names for the credential quartet", () => {
		expect(rendered.body).to.contain('<item name="account.1.sip.userid">1001</item>');
		expect(rendered.body).to.contain('<item name="account.1.sip.subscriber.userid">1001</item>');
		expect(rendered.body).to.contain(
			'<item name="account.1.sip.subscriber.password">s3cret-derived</item>',
		);
		expect(rendered.body).to.contain(
			'<item name="account.1.sip.subscriber.name">Alice Nguyen</item>',
		);
	});

	it("writes registerExpiration in MINUTES, which is the device-facing bug if wrong", () => {
		expect(rendered.body).to.contain('<item name="account.1.sip.registerExpiration">60</item>');
		expect(clampMinutes(3600)).to.equal(60);
		expect(clampMinutes(30)).to.equal(1);
		expect(clampMinutes(999_999_999)).to.equal(64_800);
	});

	it("uses STRING key modes, avoiding the conflicting integer scales", () => {
		expect(rendered.body).to.contain('<item name="pks.vpk.1.keyMode">BLF</item>');
		expect(rendered.body).to.contain('<item name="pks.vpk.2.keyMode">SpeedDial</item>');
		expect(rendered.body).to.not.match(/pks\.vpk\.1\.keyMode">\d/u);
	});

	it("0-indexes a key's account while the account itself is 1-indexed", () => {
		expect(rendered.body).to.contain('<item name="pks.vpk.1.account">0</item>');
	});

	it("puts a non-default registrar port in the server address, not in localPort", () => {
		const alt = renderWith(
			templateFor("grandstream")!,
			context({ vendor: "grandstream", lines: [{ ...context().lines[0]!, serverPort: 5070 }] }),
		);
		expect(alt.body).to.contain(
			'<item name="account.1.sip.server.1.address">pbx.example.com:5070</item>',
		);
		expect(alt.body).to.not.contain("localPort");
	});

	it("packs VPKs contiguously, because a gap ends the list on this vendor", () => {
		const sparse = renderWith(
			templateFor("grandstream")!,
			context({
				vendor: "grandstream",
				keys: [
					{
						category: "memory",
						keyIndex: 9,
						keyType: "blf",
						value: "1002",
						label: "Ben",
						lineNumber: 1,
					},
				],
			}),
		);
		expect(sparse.body).to.contain('<item name="pks.vpk.1.keyMode">BLF</item>');
		expect(sparse.body).to.not.contain("pks.vpk.9");
	});
});

describe("Fanvil rendering", () => {
	const rendered = renderWith(templateFor("fanvil")!, context({ vendor: "fanvil", model: "X5U" }));

	it("carries the mandatory banner and terminator", () => {
		expect(rendered.body.split("\r\n")[0]).to.match(/^<<VOIP CONFIG FILE>>Version:2\.\d{10}$/u);
		expect(rendered.body.trimEnd().endsWith("<<END OF FILE>>")).to.equal(true);
	});

	it("uses CRLF, which the header is documented to require", () => {
		expect(rendered.body).to.contain("\r\n");
	});

	it("derives the version from the content, because the phone will not re-apply an unchanged one", () => {
		const changed = renderWith(
			templateFor("fanvil")!,
			context({ vendor: "fanvil", lines: [{ ...context().lines[0]!, registerUser: "1009" }] }),
		);
		const versionOf = (body: string) => body.split("\r\n")[0];
		expect(versionOf(changed.body)).to.not.equal(versionOf(rendered.body));
		expect(fanvilVersionFor("a")).to.not.equal(fanvilVersionFor("b"));
		expect(fanvilVersionFor("a")).to.equal(fanvilVersionFor("a"));
	});

	it("uses the ' :' separator and the verified parameter names", () => {
		expect(rendered.body).to.contain("SIP1 Register User :1001");
		expect(rendered.body).to.contain("SIP1 Register Pswd :s3cret-derived");
		expect(rendered.body).to.contain("SIP1 Transport :0");
		expect(rendered.body).to.not.match(/^SIP1 Register User=/mu);
	});

	it("uses the DSSKEY module header and the number@line/subtype value encoding", () => {
		expect(rendered.body).to.contain("<DSSKEY CONFIG MODULE>");
		expect(rendered.body).to.contain("Fkey1 Type :1");
		expect(rendered.body).to.contain("Fkey1 Value :1002@1/bc");
		expect(rendered.body).to.contain("Fkey2 Value :+12125550100@1");
	});

	it("renders an unverified key kind as None rather than a guessed subtype letter", () => {
		const park = renderWith(
			templateFor("fanvil")!,
			context({
				vendor: "fanvil",
				keys: [
					{
						category: "memory",
						keyIndex: 1,
						keyType: "park",
						value: "700",
						label: "P",
						lineNumber: 1,
					},
				],
			}),
		);
		expect(park.body).to.contain("Fkey1 Type :0");
	});
});

describe("Snom rendering", () => {
	const rendered = renderWith(templateFor("snom")!, context({ vendor: "snom", model: "D785" }));

	it("indexes accounts with an attribute", () => {
		expect(rendered.body).to.contain('<user_name idx="1" perm="R">1001</user_name>');
		expect(rendered.body).to.contain('<user_pname idx="1" perm="R">1001</user_pname>');
		expect(rendered.body).to.contain('<user_pass idx="1" perm="R">s3cret-derived</user_pass>');
	});

	it("writes credentials read-only and preferences read-write, never the whitespace forms", () => {
		expect(rendered.body).to.contain('<user_host idx="1" perm="R">');
		expect(rendered.body).to.contain('<user_active idx="1" perm="RW">on</user_active>');
		expect(rendered.body).to.not.contain('perm=" "');
		expect(rendered.body).to.not.contain('perm=""');
	});

	it("carries the transport as a user_outbound suffix, because there is no transport parameter", () => {
		expect(rendered.body).to.contain(";udp</user_outbound>");
		expect(rendered.body).to.not.contain("user_server_type");
		const tls = renderWith(
			templateFor("snom")!,
			context({ vendor: "snom", lines: [{ ...context().lines[0]!, transport: "tls" }] }),
		);
		expect(tls.body).to.contain(";tls</user_outbound>");
	});

	it("0-indexes function keys, which is Snom's exception to every other vendor", () => {
		expect(rendered.body).to.contain('<fkey idx="0" context="1"');
		expect(rendered.body).to.contain("blf sip:1002@pbx.example.com;user=phone");
		expect(rendered.body).to.contain("speed +12125550100");
	});

	it("appends a non-default port to the host", () => {
		const alt = renderWith(
			templateFor("snom")!,
			context({ vendor: "snom", lines: [{ ...context().lines[0]!, serverPort: 5061 }] }),
		);
		expect(alt.body).to.contain("pbx.example.com:5061");
	});
});

describe("softphone payload", () => {
	it("builds a sip: URI with encoded userinfo", () => {
		expect(
			sipAccountUri({
				user: "1001",
				password: "p@ss:word",
				host: "pbx.example.com",
				port: 5060,
				transport: "udp",
			}),
		).to.equal("sip:1001:p%40ss%3Aword@pbx.example.com;transport=udp");
	});

	it("includes a non-default port", () => {
		expect(
			sipAccountUri({
				user: "1001",
				password: "x",
				host: "pbx.example.com",
				port: 5061,
				transport: "tls",
			}),
		).to.equal("sip:1001:x@pbx.example.com:5061;transport=tls");
	});

	it("points the QR at the payload URL, because a bare sip: URI would place a call", () => {
		const payload = softphonePayload(context({ vendor: "softphone" }));
		expect(payload.qr.url).to.equal("https://pbx.example.com/provision/ref.secret/payload");
		expect(payload.qr.note).to.contain("place a call");
	});

	it("carries one account per line with the fields a client needs", () => {
		const payload = softphonePayload(context({ vendor: "softphone", model: "GROUNDWIRE" }));
		expect(payload.version).to.equal(1);
		expect(payload.accounts).to.have.length(1);
		expect(payload.accounts[0]?.username).to.equal("1001");
		expect(payload.accounts[0]?.password).to.equal("s3cret-derived");
		expect(payload.accounts[0]?.sipUri).to.contain("sip:1001:");
		expect(payload.device.macAddress).to.equal("001565abcdef");
	});
});

describe("the generic template", () => {
	it("says out loud that no phone will accept it", () => {
		const rendered = renderWith(templateFor("generic")!, context({ vendor: "generic" }));
		expect(rendered.body).to.contain("NOT a vendor provisioning format");
	});
});

describe("rendering is deterministic", () => {
	it("produces identical bytes for an unchanged device", () => {
		for (const vendor of DEVICE_VENDORS) {
			const template = templateFor(vendor)!;
			const first = renderWith(template, context({ vendor, settings: { b: 2, a: 1 } }));
			const second = renderWith(template, context({ vendor, settings: { a: 1, b: 2 } }));
			expect(second.body, vendor).to.equal(first.body);
		}
	});
});
