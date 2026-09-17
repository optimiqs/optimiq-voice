import { Reflector } from "@nestjs/core";
import { expect } from "chai";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import {
	rotateSecretDto,
	setSecretDto,
	SipCredentialRotationController,
} from "../../src/pbx/sip-credentials/sip-credential-rotation.controller";
import {
	DEFAULT_GRACE_MINUTES,
	graceExpiry,
	MAX_GRACE_MINUTES,
	newSecretRef,
} from "../../src/pbx/sip-credentials/sip-credential-rotation.service";
import {
	MIN_SIP_SECRET_LENGTH,
	weakSipSecretMessage,
	weakSipSecretReason,
} from "../../src/pbx/sip-credentials/sip-secret-strength";

/**
 * Credential hygiene: rotation with a grace period, and the refusal of a weak hand-set secret.
 *
 * The parity audit's gap is that there was no rotation endpoint at all, and the reason there was
 * none is the thing this has to get right: the new password reaches a handset through a fetch the
 * HANDSET schedules, so a rotation with no grace is a desk phone that silently stops ringing. What
 * a first implementation can get wrong:
 *
 *  1. **Which value is kept.** Keeping the OLD handle rather than staging the new one is what makes
 *     the rendered config, the credential reply and the audit row agree from the instant of the
 *     write. Staging the new one leaves a window where they disagree.
 *  2. **A zero grace has to be expressible.** A rotation performed BECAUSE a credential leaked wants
 *     the old password to stop working now; a courtesy window to the handset is a courtesy window
 *     to whoever has the password.
 *  3. **A handle is not a credential, but it is the whole input to one.** Neither the old nor the new
 *     `secretRef` may reach the audit ledger, which anyone with SELECT can read.
 *  4. **The strength rules must be actionable.** A refusal a person cannot understand is a refusal
 *     they route around by picking something worse.
 */

describe("the SIP secret strength check", () => {
	it("refuses anything shorter than the minimum", () => {
		// There is no lockout on a REGISTER and the attack is offline against a digest anybody can
		// elicit, so length is the only term with an exponent on it.
		expect(weakSipSecretReason("Ab3!xY")).to.equal("too-short");
		expect(MIN_SIP_SECRET_LENGTH).to.equal(12);
	});

	it("requires three of four character classes, not four", () => {
		// Four classes is the rule that produces `Password1!` on every system that has ever had one.
		expect(weakSipSecretReason("abcdefghijklmnop")).to.equal("too-few-character-classes");
		expect(weakSipSecretReason("qR7zLm4vXp9w")).to.equal(undefined);
		expect(weakSipSecretReason("qR7zLm4vXp9w!")).to.equal(undefined);
	});

	it("catches the values a scanner tries first, including the trailing-digits habit", () => {
		// `sip12345` and `sip` collapse to one entry, which is what makes a deny list this small
		// worth having at all.
		expect(weakSipSecretReason("sipPassword1")).to.equal("well-known");
		expect(weakSipSecretReason("Asterisk1234")).to.equal("well-known");
	});

	it("catches a repeated character that is long enough to pass rule one", () => {
		expect(weakSipSecretReason("aaaaaaaaaaaaaaaa")).to.equal("too-few-character-classes");
		expect(weakSipSecretReason("aA1aA1aA1aA1")).to.equal(undefined);
	});

	it("catches a full sequential run and nothing cleverer", () => {
		// A partial-run heuristic refuses real passphrases that happen to contain `stuv`.
		expect(weakSipSecretReason("abcdefghijkl")).to.equal("too-few-character-classes");
		expect(weakSipSecretReason("Wq4stuvXm9zB")).to.equal(undefined);
	});

	it("explains every refusal without quoting the secret back", () => {
		for (const reason of [
			"too-short",
			"too-few-character-classes",
			"well-known",
			"repeated-character",
			"sequential",
		] as const) {
			const message = weakSipSecretMessage(reason);
			expect(message.length, reason).to.be.greaterThan(20);
			expect(message, reason).to.not.include("sipPassword");
		}
	});
});

describe("the grace window", () => {
	it("defaults to fifteen minutes", () => {
		// Long enough for a phone that polls its provisioning URL on the usual interval; short enough
		// that a rotation performed because a credential leaked does not leave it usable all shift.
		expect(DEFAULT_GRACE_MINUTES).to.equal(15);
		const until = graceExpiry(DEFAULT_GRACE_MINUTES);
		expect(until).to.not.equal(null);
		expect((until as Date).getTime() - Date.now()).to.be.closeTo(15 * 60_000, 2_000);
	});

	it("makes a zero grace a closed window rather than a default one", () => {
		// The incident-response case. `null` is what the column stores, and the credential path reads
		// a null expiry as "the previous secret is not accepted now".
		expect(graceExpiry(0)).to.equal(null);
		expect(graceExpiry(-5)).to.equal(null);
	});

	it("clamps rather than refuses an over-long grace", () => {
		const until = graceExpiry(MAX_GRACE_MINUTES * 10) as Date;
		expect(until.getTime() - Date.now()).to.be.closeTo(MAX_GRACE_MINUTES * 60_000, 2_000);
	});

	it("refuses a grace the DTO cannot express", () => {
		expect(rotateSecretDto.parse({}).graceMinutes).to.equal(DEFAULT_GRACE_MINUTES);
		expect(rotateSecretDto.parse({ graceMinutes: 0 }).graceMinutes).to.equal(0);
		expect(rotateSecretDto.safeParse({ graceMinutes: MAX_GRACE_MINUTES + 1 }).success).to.equal(
			false,
		);
		expect(rotateSecretDto.safeParse({ graceMinutes: -1 }).success).to.equal(false);
	});
});

describe("a new secret handle", () => {
	it("is random rather than derived from the row", () => {
		// The handle is the whole input to the password derivation, so one that encoded an id and a
		// counter would let anyone who saw one predict the next.
		const handles = new Set(Array.from({ length: 64 }, () => newSecretRef()));
		expect(handles.size).to.equal(64);
	});

	it("uses the base64url alphabet the renderer already travels through", () => {
		expect(newSecretRef()).to.match(/^[A-Za-z0-9_-]+$/u);
		expect(newSecretRef().length).to.be.greaterThan(40);
	});
});

describe("the rotation DTOs", () => {
	it("bounds the plaintext at both ends", () => {
		// The minimum mirrors the strength rule so an obviously-short secret is a body error; the
		// maximum exists so an attacker-chosen megabyte never reaches an MD5.
		expect(setSecretDto.safeParse({ secret: "qR7zLm4vXp9w" }).success).to.equal(true);
		expect(setSecretDto.safeParse({ secret: "short" }).success).to.equal(false);
		expect(setSecretDto.safeParse({ secret: "x".repeat(129) }).success).to.equal(false);
	});

	it("refuses an unknown key rather than dropping it", () => {
		expect(setSecretDto.safeParse({ secret: "qR7zLm4vXp9w", ha1: "…" }).success).to.equal(false);
	});
});

describe("the rotation controller's grants", () => {
	const reflector = new Reflector();

	function permissionsOf(method: keyof SipCredentialRotationController): readonly string[] {
		return (
			reflector.get<string[]>(
				REQUIRE_PERMISSIONS_METADATA,
				SipCredentialRotationController.prototype[method] as never,
			) ?? []
		);
	}

	it("guards every route with security.rotate-credentials", () => {
		// Deliberately not `security.write` (which opens a CIDR while looking at a list) and not
		// `extensions.write` (configuration, held by everyone who administers phones). This one
		// invalidates the credential a physical handset is holding.
		for (const method of ["rotateExtension", "rotateDeviceLine", "setSecret"] as const) {
			expect(permissionsOf(method), method).to.deep.equal(["security.rotate-credentials"]);
		}
	});
});
