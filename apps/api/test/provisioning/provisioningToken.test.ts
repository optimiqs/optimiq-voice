import { BadRequestException } from "@nestjs/common";
import { expect } from "chai";
import { parseDto } from "../../src/pbx/shared/dto";
import { normalizeDeviceSearch } from "../../src/provisioning/devices/devices.controller";
import {
	createDeviceDto,
	createDeviceKeyDto,
	createDeviceLineDto,
	updateDeviceDto,
} from "../../src/provisioning/devices/devices.dto";
import {
	loadProvisioningEnv,
	missingRenderConfiguration,
} from "../../src/provisioning/provisioning-env";
import { ProvisioningRateLimiter } from "../../src/provisioning/render/provision-rate-limit";
import { deriveSipPassword } from "../../src/provisioning/render/provision-secret";
import {
	mintProvisioningToken,
	parseProvisioningToken,
	provisioningConfigUrl,
	secretMatchesHash,
	sha256Hex,
} from "../../src/provisioning/render/provision-token";

/**
 * The security-critical half, without a database.
 *
 * Every assertion here is about a property the render endpoint's safety rests on: that a token's
 * secret is never stored, that a rotated token invalidates its predecessor, that the limiter counts
 * per device, and that a MAC cannot be entered twice under two spellings.
 */

describe("provisioning tokens", () => {
	it("mints a two-part token and stores only the reference plus a digest", () => {
		const minted = mintProvisioningToken();
		expect(minted.token).to.contain(".");
		expect(minted.token.startsWith(`${minted.reference}.`)).to.equal(true);
		// The secret must not be recoverable from anything that reaches the database.
		const secret = minted.token.slice(minted.reference.length + 1);
		expect(minted.reference).to.not.contain(secret);
		expect(minted.secretHash).to.equal(sha256Hex(secret));
		expect(minted.secretHash).to.match(/^[0-9a-f]{64}$/u);
	});

	it("produces a distinct token every time", () => {
		const tokens = new Set(Array.from({ length: 64 }, () => mintProvisioningToken().token));
		expect(tokens.size).to.equal(64);
	});

	it("splits a presented token into a lookup half and a verified half", () => {
		const parsed = parseProvisioningToken("abc123.def456");
		expect(parsed?.reference).to.equal("abc123");
		expect(parsed?.secret).to.equal("def456");
	});

	it("treats a separator-less token as a legacy token with no secret", () => {
		const parsed = parseProvisioningToken("legacyplaintext");
		expect(parsed?.reference).to.equal("legacyplaintext");
		expect(parsed?.secret).to.equal(undefined);
	});

	it("refuses anything that is not plausibly a token before it reaches a query", () => {
		for (const bad of ["", "a".repeat(300), "has spaces", "has/slash", "a.b.c", "semi;colon"]) {
			expect(parseProvisioningToken(bad), JSON.stringify(bad)).to.equal(undefined);
		}
	});

	it("verifies a secret against its digest and rejects a near miss", () => {
		const minted = mintProvisioningToken();
		const secret = minted.token.slice(minted.reference.length + 1);
		expect(secretMatchesHash(secret, minted.secretHash)).to.equal(true);
		expect(secretMatchesHash(`${secret}x`, minted.secretHash)).to.equal(false);
		expect(secretMatchesHash(secret.slice(0, -1), minted.secretHash)).to.equal(false);
	});

	it("refuses a stored digest that is not 32 bytes of hex rather than comparing it", () => {
		expect(secretMatchesHash("anything", "")).to.equal(false);
		expect(secretMatchesHash("anything", "not-hex")).to.equal(false);
		expect(secretMatchesHash("anything", "ab".repeat(31))).to.equal(false);
	});

	it("a rotated token's secret does not verify against the previous digest", () => {
		const first = mintProvisioningToken();
		const second = mintProvisioningToken();
		const secondSecret = second.token.slice(second.reference.length + 1);
		expect(secretMatchesHash(secondSecret, first.secretHash)).to.equal(false);
	});

	it("builds the URL a phone fetches, tolerating a trailing slash on the base", () => {
		expect(provisioningConfigUrl("https://pbx.example.com/", "ref.secret")).to.equal(
			"https://pbx.example.com/provision/ref.secret/config",
		);
	});
});

describe("the derived SIP password", () => {
	const base = {
		rootKey: "root-key-at-least-sixteen",
		organizationId: "org-a",
		secretRef: "s://1001",
	};

	it("is deterministic, so a phone that re-provisions keeps registering", () => {
		expect(deriveSipPassword(base)).to.equal(deriveSipPassword(base));
	});

	it("separates tenants that chose the same secret ref", () => {
		expect(deriveSipPassword(base)).to.not.equal(
			deriveSipPassword({ ...base, organizationId: "org-b" }),
		);
	});

	it("changes when the root key rotates, which is what makes a compromise recoverable", () => {
		expect(deriveSipPassword(base)).to.not.equal(
			deriveSipPassword({ ...base, rootKey: "other-key-sixteen+" }),
		);
	});

	it("stays inside an alphabet every vendor's plain-text parser accepts", () => {
		expect(deriveSipPassword(base)).to.match(/^[A-Za-z0-9_-]{24}$/u);
	});
});

describe("the rate limiter", () => {
	it("allows up to the budget and then refuses", () => {
		const limiter = new ProvisioningRateLimiter(3);
		const now = 1_000_000;
		expect(limiter.consume("ref", now).allowed).to.equal(true);
		expect(limiter.consume("ref", now).allowed).to.equal(true);
		expect(limiter.consume("ref", now).allowed).to.equal(true);
		const refused = limiter.consume("ref", now);
		expect(refused.allowed).to.equal(false);
		expect(refused.remaining).to.equal(0);
		expect(refused.retryAfterSeconds).to.be.greaterThan(0);
	});

	it("counts per device, so one phone's boot loop does not lock out another", () => {
		const limiter = new ProvisioningRateLimiter(1);
		const now = 1_000_000;
		expect(limiter.consume("a", now).allowed).to.equal(true);
		expect(limiter.consume("b", now).allowed).to.equal(true);
		expect(limiter.consume("a", now).allowed).to.equal(false);
	});

	it("opens a fresh window after a minute", () => {
		const limiter = new ProvisioningRateLimiter(1);
		const now = 1_000_000;
		expect(limiter.consume("ref", now).allowed).to.equal(true);
		expect(limiter.consume("ref", now).allowed).to.equal(false);
		expect(limiter.consume("ref", now + 60_001).allowed).to.equal(true);
	});
});

describe("the provisioning environment", () => {
	it("names exactly what is missing before the render endpoint can answer", () => {
		const env = loadProvisioningEnv({});
		expect(missingRenderConfiguration(env)).to.deep.equal([
			"PROVISION_SIP_SERVER",
			"PROVISION_SIP_SECRET_KEY",
		]);
	});

	it("is complete once both are set", () => {
		const env = loadProvisioningEnv({
			PROVISION_SIP_SERVER: "pbx.example.com",
			PROVISION_SIP_SECRET_KEY: "root-key-at-least-sixteen",
		});
		expect(missingRenderConfiguration(env)).to.deep.equal([]);
	});

	it("strips a trailing slash from the base URL so the phone's URL has one separator", () => {
		const env = loadProvisioningEnv({ PROVISION_BASE_URL: "https://pbx.example.com//" });
		expect(env.PROVISION_BASE_URL).to.equal("https://pbx.example.com");
	});

	it("refuses a root key too short to be one", () => {
		expect(() => loadProvisioningEnv({ PROVISION_SIP_SECRET_KEY: "short" })).to.throw();
	});
});

describe("device DTOs", () => {
	it("normalizes every MAC spelling to the storage form", () => {
		for (const spelling of ["00:15:65:AB:CD:EF", "0015.65ab.cdef", "001565ABCDEF"]) {
			const parsed = parseDto(createDeviceDto, { macAddress: spelling });
			expect(parsed.macAddress, spelling).to.equal("001565abcdef");
		}
	});

	it("rejects a malformed MAC with a field-addressed 400", () => {
		expect(() => parseDto(createDeviceDto, { macAddress: "not-a-mac-at-all" })).to.throw(
			BadRequestException,
		);
	});

	it("refuses to accept a provisioning token from a client, on create or update", () => {
		expect(() =>
			parseDto(createDeviceDto, { macAddress: "001565abcdef", provisioningToken: "attacker" }),
		).to.throw(BadRequestException);
		expect(() => parseDto(updateDeviceDto, { provisioningTokenHash: "0".repeat(64) })).to.throw(
			BadRequestException,
		);
	});

	it("refuses to accept the render path's own check-in columns", () => {
		expect(() =>
			parseDto(updateDeviceDto, { lastProvisionedAt: "2026-08-06T00:00:00.000Z" }),
		).to.throw(BadRequestException);
	});

	it("accepts a scalar settings bag and refuses a nested one", () => {
		expect(
			parseDto(createDeviceDto, {
				macAddress: "001565abcdef",
				settings: { "features.dnd.enable": 1, timezone: "UTC", quiet: true },
			}).settings,
		).to.deep.equal({ "features.dnd.enable": 1, timezone: "UTC", quiet: true });
		expect(() =>
			parseDto(createDeviceDto, { macAddress: "001565abcdef", settings: { nested: { a: 1 } } }),
		).to.throw(BadRequestException);
	});

	it("bounds a line number to something a phone could have", () => {
		expect(parseDto(createDeviceLineDto, { lineNumber: 1 }).lineNumber).to.equal(1);
		expect(() => parseDto(createDeviceLineDto, { lineNumber: 0 })).to.throw(BadRequestException);
		expect(() => parseDto(createDeviceLineDto, { lineNumber: 999 })).to.throw(BadRequestException);
	});

	it("accepts the key vocabulary the schema declares", () => {
		const key = parseDto(createDeviceKeyDto, {
			category: "memory",
			keyIndex: 3,
			keyType: "blf",
			value: "1002",
			label: "Ben",
		});
		expect(key.keyType).to.equal("blf");
		expect(() => parseDto(createDeviceKeyDto, { keyIndex: 1, keyType: "wormhole" })).to.throw(
			BadRequestException,
		);
	});
});

describe("device search", () => {
	it("normalizes a MAC fragment so the label on the phone finds the row", () => {
		expect(normalizeDeviceSearch({ page: 1, limit: 20, search: "00:15:65:AB" }).search).to.equal(
			"001565ab",
		);
	});

	it("leaves a word alone so the label and model columns still match", () => {
		expect(normalizeDeviceSearch({ page: 1, limit: 20, search: "Reception" }).search).to.equal(
			"Reception",
		);
		expect(normalizeDeviceSearch({ page: 1, limit: 20, search: "T54W" }).search).to.equal("T54W");
	});

	it("leaves a fragment shorter than an OUI alone", () => {
		expect(normalizeDeviceSearch({ page: 1, limit: 20, search: "ab:cd" }).search).to.equal("ab:cd");
	});

	it("passes an absent search through untouched", () => {
		expect(normalizeDeviceSearch({ page: 1, limit: 20, search: undefined }).search).to.equal(
			undefined,
		);
	});
});
