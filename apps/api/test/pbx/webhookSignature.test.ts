import { expect } from "chai";
import {
	generateWebhookSecret,
	signWebhookBody,
	verifyWebhookSignature,
} from "../../src/pbx/webhooks/webhook-signature";

/**
 * The signature, pinned to a literal vector.
 *
 * A hard-coded expected digest rather than "sign it and verify it", because a round trip through
 * our own two functions passes even if BOTH change — and the whole value of this scheme is that a
 * third party who has never seen our code can compute the same string. The vector below is what
 * `openssl dgst -sha256 -hmac whsec_test` produces for the same input, so a change to what is signed
 * (dropping the timestamp, signing a re-serialized body, switching separator) fails here rather than
 * in somebody else's integration.
 */

/** `HMAC-SHA256("whsec_test", "1786185600.{\"id\":\"evt-1\"}")`, lower-case hex. */
const VECTOR = {
	secret: "whsec_test",
	body: JSON.stringify({ id: "evt-1" }),
	timestamp: 1_786_185_600,
	signature: "4a4ab71d61119de7a569b98d232caf1cec0341cc25d37874eb229753c08e85fd",
};

describe("webhook signature", () => {
	it("produces the pinned Stripe-style header", () => {
		expect(signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp)).to.equal(
			`t=${VECTOR.timestamp},v1=${VECTOR.signature}`,
		);
	});

	it("binds the timestamp into the MAC, so a replay cannot be re-stamped", () => {
		const original = signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp);
		const later = signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp + 1);
		expect(later).to.not.equal(original);

		// The attack this closes: take an observed delivery, rewrite `t` to now, resend.
		const forged = `t=${VECTOR.timestamp + 100_000},v1=${VECTOR.signature}`;
		expect(
			verifyWebhookSignature(VECTOR.secret, VECTOR.body, forged, VECTOR.timestamp + 100_000),
		).to.equal(false);
	});

	it("verifies its own header inside the tolerance and refuses it outside", () => {
		const header = signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp);
		expect(
			verifyWebhookSignature(VECTOR.secret, VECTOR.body, header, VECTOR.timestamp + 60, 300),
		).to.equal(true);
		expect(
			verifyWebhookSignature(VECTOR.secret, VECTOR.body, header, VECTOR.timestamp + 600, 300),
		).to.equal(false);
	});

	it("refuses a body that changed by one byte, and a secret that is not the subscription's", () => {
		const header = signWebhookBody(VECTOR.secret, VECTOR.body, VECTOR.timestamp);
		expect(
			verifyWebhookSignature(VECTOR.secret, `${VECTOR.body} `, header, VECTOR.timestamp, 0),
		).to.equal(false);
		expect(
			verifyWebhookSignature("whsec_other", VECTOR.body, header, VECTOR.timestamp, 0),
		).to.equal(false);
	});

	it("refuses a malformed header rather than throwing", () => {
		for (const header of ["", "v1=abc", "t=notanumber,v1=abc", `t=${VECTOR.timestamp}`]) {
			expect(
				verifyWebhookSignature(VECTOR.secret, VECTOR.body, header, VECTOR.timestamp, 0),
				header,
			).to.equal(false);
		}
		// A signature of the wrong LENGTH must not reach `timingSafeEqual`, which throws on one.
		expect(
			verifyWebhookSignature(
				VECTOR.secret,
				VECTOR.body,
				`t=${VECTOR.timestamp},v1=ab`,
				VECTOR.timestamp,
				0,
			),
		).to.equal(false);
	});

	it("generates a prefixed 256-bit secret, and a different one each time", () => {
		const first = generateWebhookSecret();
		const second = generateWebhookSecret();
		expect(first).to.match(/^whsec_[A-Za-z0-9_-]{43}$/u);
		expect(first).to.not.equal(second);
	});
});
