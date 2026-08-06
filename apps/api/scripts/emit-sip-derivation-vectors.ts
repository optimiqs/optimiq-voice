/**
 * Golden vectors for the shared SIP credential derivation, produced BY the TypeScript
 * implementation.
 *
 * ## Why this exists
 *
 * `src/provisioning/render/provision-secret.ts` decides what password a provisioned phone is told
 * to use. `apps/sipd/internal/credentials/derive.go` decides what password the registrar will
 * accept. If those two ever disagree by one byte, every handset on the deployment fails to
 * register, and it fails *silently* — the phone reports "registration failed" and nothing on
 * either side knows why. A second hand-written implementation in another language, tested against
 * a second hand-written expectation, would not catch that: it would only prove Go agrees with
 * whoever wrote the Go test.
 *
 * So this script writes the answers the **real** TypeScript function gives, and Go asserts against
 * them. It is the same pattern `packages/events` uses for `packages/events-go/testdata/parity.json`
 * (see `packages/events/scripts/generate-go.ts` § "parity golden"), for the same reason.
 *
 * ## Properties
 *
 * Every vector is a pure function of the constants below — no clock, no randomness, no
 * environment — so re-running the script on any machine produces a byte-identical file. That is
 * what makes `--check` a meaningful drift gate rather than a coin toss.
 *
 * ```bash
 * pnpm --filter @optimiq-voice/api emit:sip-vectors            # write
 * pnpm --filter @optimiq-voice/api emit:sip-vectors -- --check # fail if the file is stale
 * ```
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveSipPassword } from "../src/provisioning/render/provision-secret";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where `apps/sipd` reads it from. Relative so the script works from any working directory. */
const OUTPUT = resolve(HERE, "../../sipd/internal/credentials/testdata/derive_parity.json");

/**
 * `ha1` as RFC 2617 defines it, and as `apps/sipd`'s `credentials.HA1` computes it.
 *
 * Restated here rather than imported because the point of the exercise is to pin the *composition*
 * — password derivation followed by digest hashing — which is the whole chain a REGISTER walks.
 * `apps/api`'s credential responder performs exactly this composition.
 */
function ha1(username: string, realm: string, password: string): string {
	return createHash("md5").update(`${username}:${realm}:${password}`, "utf8").digest("hex");
}

interface Vector {
	readonly name: string;
	readonly rootKey: string;
	readonly organizationId: string;
	readonly secretRef: string;
	readonly username: string;
	readonly realm: string;
	readonly password: string;
	readonly ha1: string;
}

/**
 * The cases, chosen for what they can break rather than for coverage percentage:
 *
 * - `ordinary` — the shape a real deployment produces.
 * - `same-ref-other-tenant` — pins tenant separation. Its password MUST differ from `ordinary`'s
 *   despite an identical `secretRef`; a Go port that forgot the org, or used a different
 *   separator, would produce the same string here and the test would catch it.
 * - `rotated-key` — pins that the key is the HMAC key and not, say, a prefix on the message.
 * - `unicode-secret-ref` — pins UTF-8 encoding of the message. Go's `[]byte(s)` and Node's
 *   `"utf8"` agree, but only if both are actually treating the input as UTF-8.
 * - `long-key` / `short-key` — the key is used verbatim, so HMAC's own block-size handling
 *   (keys > 64 bytes are hashed first, shorter ones zero-padded) has to match. It does, because
 *   both sides use a real HMAC — this vector is what proves nobody replaced it with a hash of a
 *   concatenation.
 * - `separator-adjacent` / `separator-adjacent-shifted` — two DIFFERENT inputs that produce the
 *   SAME message, `org-a:b:c`, and therefore the same password. The concatenation is not
 *   injective over arbitrary strings, and this pair pins that both languages agree on that fact
 *   rather than one of them quietly "fixing" it — which would be a credential rotation, not a
 *   bug fix. It is unreachable in practice: `organizationId` is a UUID and contains no colon, so
 *   a real message's split point is unambiguous however many colons `secretRef` has (device refs
 *   legitimately carry MAC-address colons — see `device-line-ref`).
 */
const CASES: readonly Omit<Vector, "password" | "ha1">[] = [
	{
		name: "ordinary",
		rootKey: "provision-root-key-0123456789abcdef",
		organizationId: "018f4f5e-0000-7000-8000-0000000000a1",
		secretRef: "ext/1001/sip",
		username: "1001",
		realm: "acme.example.com",
	},
	{
		name: "same-ref-other-tenant",
		rootKey: "provision-root-key-0123456789abcdef",
		organizationId: "018f4f5e-0000-7000-8000-0000000000b2",
		secretRef: "ext/1001/sip",
		username: "1001",
		realm: "acme.example.com",
	},
	{
		name: "rotated-key",
		rootKey: "provision-root-key-ROTATED-0123456789",
		organizationId: "018f4f5e-0000-7000-8000-0000000000a1",
		secretRef: "ext/1001/sip",
		username: "1001",
		realm: "acme.example.com",
	},
	{
		name: "unicode-secret-ref",
		rootKey: "provision-root-key-0123456789abcdef",
		organizationId: "018f4f5e-0000-7000-8000-0000000000a1",
		secretRef: "ext/ünïcode-Ω-日本語/sip",
		username: "1002",
		realm: "münchen.example.com",
	},
	{
		name: "long-key",
		// 96 bytes — longer than HMAC-SHA256's 64-byte block, so the key is hashed first.
		rootKey: "k".repeat(96),
		organizationId: "018f4f5e-0000-7000-8000-0000000000a1",
		secretRef: "ext/1003/sip",
		username: "1003",
		realm: "acme.example.com",
	},
	{
		name: "short-key",
		// The schema's floor is 16 characters; this is exactly it.
		rootKey: "0123456789abcdef",
		organizationId: "018f4f5e-0000-7000-8000-0000000000a1",
		secretRef: "ext/1004/sip",
		username: "1004",
		realm: "acme.example.com",
	},
	{
		name: "separator-adjacent",
		rootKey: "provision-root-key-0123456789abcdef",
		organizationId: "org-a",
		secretRef: "b:c",
		username: "1005",
		realm: "acme.example.com",
	},
	{
		name: "separator-adjacent-shifted",
		rootKey: "provision-root-key-0123456789abcdef",
		organizationId: "org-a:b",
		secretRef: "c",
		username: "1005",
		realm: "acme.example.com",
	},
	{
		name: "device-line-ref",
		rootKey: "provision-root-key-0123456789abcdef",
		organizationId: "018f4f5e-0000-7000-8000-0000000000c3",
		secretRef: "device/aa:bb:cc:dd:ee:ff/line/1",
		username: "2001",
		realm: "sip.optimiq-voice.local",
	},
];

function buildVectors(): readonly Vector[] {
	return CASES.map((input) => {
		const password = deriveSipPassword({
			rootKey: input.rootKey,
			organizationId: input.organizationId,
			secretRef: input.secretRef,
		});
		return { ...input, password, ha1: ha1(input.username, input.realm, password) };
	});
}

function render(): string {
	const document = {
		$comment:
			"GENERATED by apps/api/scripts/emit-sip-derivation-vectors.ts from " +
			"apps/api/src/provisioning/render/provision-secret.ts. Do not hand-edit — " +
			"apps/sipd/internal/credentials asserts against it.",
		algorithm: "hmac-sha256",
		message: "<organizationId>:<secretRef>",
		encoding: "base64url (unpadded)",
		passwordLength: 24,
		ha1: "md5(<username>:<realm>:<password>), lower-case hex",
		vectors: buildVectors(),
	};
	return `${JSON.stringify(document, null, "\t")}\n`;
}

function main(): void {
	const rendered = render();
	const check = process.argv.includes("--check");

	if (!check) {
		writeFileSync(OUTPUT, rendered, "utf8");
		console.log(`wrote ${OUTPUT} (${buildVectors().length} vectors)`);
		return;
	}

	let current: string;
	try {
		current = readFileSync(OUTPUT, "utf8");
	} catch {
		console.error(`${OUTPUT} does not exist. Run without --check to create it.`);
		process.exitCode = 1;
		return;
	}

	if (current !== rendered) {
		console.error(
			`${OUTPUT} is stale — the TypeScript derivation has changed and the Go golden has not.\n` +
				"Run: pnpm --filter @optimiq-voice/api emit:sip-vectors\n" +
				"Then re-run the sipd tests; a real derivation change is a CREDENTIAL ROTATION and " +
				"every provisioned phone has to be re-provisioned.",
		);
		process.exitCode = 1;
		return;
	}

	console.log(`${OUTPUT} is current (${buildVectors().length} vectors)`);
}

main();
