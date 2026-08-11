import { expect } from "chai";
import {
	PROVISION_SETTINGS,
	PROVISION_SETTINGS_CATEGORY,
	resolveCategory,
} from "../../src/pbx/org-settings/org-settings.catalog";
import {
	resolveLinePort,
	resolveLineTransport,
	SIP_PORT_SETTING,
	SIP_TRANSPORT_SETTING,
	transportPreference,
} from "../../src/provisioning/catalog/transport-preference";
import type { ProvisioningSettings } from "@optimiq-voice/pbx-db";

/**
 * The organization's SIP transport preference — the fleet's migration path onto TLS.
 *
 * The property under test is almost entirely about what must NOT happen. Every vendor template in
 * `catalog/templates/` has been able to write `transport=tls` since it was created, so turning a
 * fleet on is one field; the risk is that the field turns itself on. A phone fetches its
 * configuration on BOOT, so a change that flipped every line would take effect one handset at a
 * time over days, and any handset that could not complete the handshake would simply stop
 * registering with no correlation to the change that caused it.
 *
 * So: `inherit` is the default, `inherit` reproduces the per-line column exactly, and the port is
 * never inferred from the transport.
 */

function settings(overrides: Record<string, string | number | boolean> = {}): ProvisioningSettings {
	return overrides;
}

describe("the SIP transport preference", () => {
	it("defaults to inherit, which is what every deployment did before it existed", () => {
		expect(transportPreference(settings())).to.equal("inherit");
		expect(resolveLineTransport(settings(), "udp")).to.equal("udp");
		expect(resolveLineTransport(settings(), "tcp")).to.equal("tcp");
	});

	it("does not default to udp, because the per-line column already exists", () => {
		// A defaulted org value of `udp` would silently overwrite a transport an administrator set on
		// a single handset — precisely the fleet-wide surprise this design avoids.
		expect(resolveLineTransport(settings(), "tls")).to.equal("tls");
	});

	it("overrides the line once the organization has made the decision", () => {
		// The org level OVERRIDES rather than defaults: a transport is a statement about the EDGE, and
		// an edge that has turned off plaintext cannot have one phone opting out.
		expect(resolveLineTransport(settings({ [SIP_TRANSPORT_SETTING]: "tls" }), "udp")).to.equal(
			"tls",
		);
		expect(resolveLineTransport(settings({ [SIP_TRANSPORT_SETTING]: "udp" }), "tls")).to.equal(
			"udp",
		);
	});

	it("falls back to inherit for a value the catalogue would have refused", () => {
		// The cascade is jsonb written by four levels, and refusing to render a phone's config over a
		// typo in a settings row would take the fleet down to protect it.
		for (const value of ["sips", "TLS", "", 5061, true]) {
			expect(
				resolveLineTransport(settings({ [SIP_TRANSPORT_SETTING]: value }), "tcp"),
				String(value),
			).to.equal("tcp");
		}
	});

	it("never infers the port from the transport", () => {
		// `device_line.server_port` is notNull with a default, so "infer unless it was set" cannot be
		// implemented — there is no way to tell a deliberate 5060 from one nobody touched. A
		// deployment terminating TLS anywhere but 5061 would be silently misprovisioned by the guess.
		expect(resolveLinePort(settings({ [SIP_TRANSPORT_SETTING]: "tls" }), 5060)).to.equal(5060);
	});

	it("takes the port from its own setting when there is one", () => {
		expect(resolveLinePort(settings({ [SIP_PORT_SETTING]: 5061 }), 5060)).to.equal(5061);
		// A settings row is not a validated column at read time, so a string is read as one.
		expect(resolveLinePort(settings({ [SIP_PORT_SETTING]: "5061" }), 5060)).to.equal(5061);
	});

	it("ignores a port that would produce a phone that cannot register", () => {
		for (const value of [0, -1, 70_000, 1.5, "n/a", true]) {
			expect(
				resolveLinePort(settings({ [SIP_PORT_SETTING]: value }), 5060),
				String(value),
			).to.equal(5060);
		}
	});
});

describe("the provision settings catalogue", () => {
	it("catalogues exactly the two keys the platform itself reads", () => {
		// The rest of the `provision` category stays open-ended: `provision.repository.ts` hands the
		// whole category to a device template, so a vendor parameter this codebase has never heard of
		// is a legitimate row.
		expect(PROVISION_SETTINGS.map((entry) => entry.name)).to.deep.equal([
			SIP_TRANSPORT_SETTING,
			SIP_PORT_SETTING,
		]);
	});

	it("resolves to the current behaviour for a tenant with no rows", () => {
		const resolved = resolveCategory(PROVISION_SETTINGS_CATEGORY, []);
		expect(resolved[SIP_TRANSPORT_SETTING]).to.equal("inherit");
		expect(resolved[SIP_PORT_SETTING]).to.equal(null);
	});

	it("validates the transport on write, so a typo is a 400 rather than a silent no-op", () => {
		const descriptor = PROVISION_SETTINGS.find((entry) => entry.name === SIP_TRANSPORT_SETTING);
		expect(descriptor?.schema.safeParse("tls").success).to.equal(true);
		expect(descriptor?.schema.safeParse("sips").success).to.equal(false);
	});

	it("treats a disabled row as absent, like every other level of the cascade", () => {
		const resolved = resolveCategory(PROVISION_SETTINGS_CATEGORY, [
			{ name: SIP_TRANSPORT_SETTING, value: "tls", enabled: false },
		]);
		expect(resolved[SIP_TRANSPORT_SETTING]).to.equal("inherit");
	});
});
