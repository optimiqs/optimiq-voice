import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { runEffect } from "@optimiq-voice/effect-runtime";
import {
	DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS,
	DERIVED_KEY_BYTES,
	formatVoicemailPinHash,
	MIN_SALT_BYTES,
	parseVoicemailPinHash,
	scryptMemoryBytes,
} from "@optimiq-voice/routing";
import { actorFromSession } from "../shared/audit-log";
import { toWireDiagnostic } from "../shared/pbx.errors";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { VOICEMAIL_BOX_RESOURCE } from "./voicemail-boxes.resource";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";
import type { VoicemailPinScryptParams } from "@optimiq-voice/routing";

const scrypt = promisify(scryptCallback) as (
	password: string | Buffer,
	salt: Buffer,
	keylen: number,
	options: { readonly N: number; readonly r: number; readonly p: number; readonly maxmem: number },
) => Promise<Buffer>;

/**
 * The mailbox PIN.
 *
 * ## Who owns what
 *
 * `packages/routing` owns the DIGEST FORMAT and nothing else — it parses and validates, and
 * deliberately holds no KDF, because giving a pure compiler one would put scrypt on the import
 * graph of the resolver. So the split is: routing states the grammar and the parameter bounds,
 * THIS file hashes, and `apps/engine` verifies on the call path. All three read the parameters out
 * of the digest rather than out of a constant, which is what makes raising the cost a re-hash on
 * next set instead of a flag day.
 *
 * ```
 * scrypt$N=16384,r=8,p=1$<salt-base64>$<hash-base64>
 * ```
 *
 * ## The PIN policy, and why it is this one
 *
 * Stated in `voicemail-boxes.dto.ts` (`voicemailPinIssue`), because it is a rule about a request
 * body and this file has no business rejecting one: digits only, `MIN_PIN_LENGTH`–`MAX_PIN_LENGTH`
 * of them. Digits because the only
 * keypad this secret is ever entered on is a telephone's, and a policy that admits characters a
 * caller cannot type is a policy that produces mailboxes nobody can open. Four as the floor
 * because it is what every PBX in the world has trained users to expect and the engine already
 * caps attempts at three (`ENGINE_VOICEMAIL_PIN_ATTEMPTS`), which is the control that actually
 * bounds online guessing. Ten as the ceiling because DTMF entry is terminated by `#` and a longer
 * secret is mistyped more often than it is guessed.
 *
 * Two shapes are refused on top of that, and the reason is the attempt limit rather than entropy:
 * with three tries per call, a PIN drawn from the handful of sequences every attacker tries FIRST
 * is materially weaker than one that is not.
 *
 * - a single repeated digit (`0000`, `9999`);
 * - a straight ascending or descending run (`1234`, `4321`).
 *
 * That is the whole blocklist. A longer one — birthdays, `1122`, keypad patterns — starts guessing
 * at what a user meant and produces "your PIN was rejected and I do not know why", which is how
 * people end up writing them on the handset.
 *
 * ## Why the write goes through the repository
 *
 * `voicemail_box` is a routing table and `pinHash` is now part of `OrgRoutingSnapshot`, so setting
 * a PIN CHANGES THE COMPILED ARTIFACT. Writing the column directly on the database client — which
 * is how `voicemail-consumer.service.ts` files messages, and correct there because
 * `affectsRouting("voicemail_message")` is false — would leave the engine verifying the previous
 * digest until something unrelated recompiled the tenant. Going through `repository.update` gets
 * compile-on-write, the KV publish and the tenant transaction for free, and is why this service
 * holds a runtime rather than a `PbxDatabaseClient`.
 */
@Injectable()
export class VoicemailPinService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) private readonly runtime: PbxRepositoryRuntime) {}

	/**
	 * Sets the mailbox's PIN.
	 *
	 * Returns the box WITHOUT its digest (`secretColumns` on the resource, applied here too), plus
	 * the compiler's warnings — a mailbox whose PIN this release could not read raises
	 * `invalid-pin-hash`, and although that cannot happen for a digest we just minted, surfacing
	 * the envelope keeps the endpoint's response shape identical to every other mutation's.
	 */
	async set(
		session: AppSession,
		id: string,
		pin: string,
	): Promise<MutationEnvelope<VoicemailPinState>> {
		return await this.write(session, id, await hashVoicemailPin(pin));
	}

	/** Clears it. The mailbox falls back to authenticating by the calling extension. */
	async clear(session: AppSession, id: string): Promise<MutationEnvelope<VoicemailPinState>> {
		return await this.write(session, id, null);
	}

	private async write(
		session: AppSession,
		id: string,
		pinHash: string | null,
	): Promise<MutationEnvelope<VoicemailPinState>> {
		const organizationId = requireActiveOrganizationId(session);
		const result = await runEffect(this.runtime, (repository) =>
			repository.update(
				organizationId,
				VOICEMAIL_BOX_RESOURCE,
				id,
				{ pinHash },
				actorFromSession(session),
			),
		);
		const row = result.row as { readonly id: string; readonly mailboxNumber: string };
		return {
			data: { id: row.id, mailboxNumber: row.mailboxNumber, pinSet: pinHash !== null },
			warnings: result.warnings.map(toWireDiagnostic),
		};
	}
}

export interface VoicemailPinState {
	readonly id: string;
	readonly mailboxNumber: string;
	/** Whether the mailbox now has a PIN. Never the digest, and never the PIN. */
	readonly pinSet: boolean;
}

/**
 * Hashes a PIN into the digest format `packages/routing` defines.
 *
 * Exported so `verify-pbx.ts` can prove the round trip end to end — mint here, parse and verify
 * with the same code path the engine uses — rather than asserting a regex against the column.
 *
 * `maxmem` is passed explicitly at twice the working set. Node's default is 32 MiB, which the
 * recommended parameters (16 MiB) fit under today; a future cost increase would otherwise fail at
 * the KDF with an opaque error rather than at the bound `packages/routing` already states.
 */
export async function hashVoicemailPin(
	pin: string,
	params: VoicemailPinScryptParams = DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS,
): Promise<string> {
	const salt = randomBytes(MIN_SALT_BYTES);
	const derived = await scrypt(pin, salt, DERIVED_KEY_BYTES, {
		N: params.cost,
		r: params.blockSize,
		p: params.parallelism,
		maxmem: scryptMemoryBytes(params) * 2,
	});
	return formatVoicemailPinHash(params, salt.toString("base64"), derived.toString("base64"));
}

/**
 * Verifies a PIN against a digest, exactly as `apps/engine` does on the call path.
 *
 * The API does not need this to authenticate anybody — nothing in the HTTP surface asks a user for
 * their mailbox PIN — and it is here because a format with a writer and no reader in the same
 * repository is a format nothing tests. `verify-pbx.ts` mints through {@link hashVoicemailPin} and
 * checks it here, so a change to either side that breaks the contract fails the gate rather than a
 * caller's `*97`.
 *
 * `parseVoicemailPinHash` rather than `readVoicemailPinHash`: the discriminated union the latter
 * returns does not narrow under `apps/api`'s tooling tsconfig, which still relaxes
 * `strictNullChecks` for its legacy files — the collision `voicemail-pin.ts` documents at length.
 */
export async function verifyVoicemailPin(pin: string, digest: string): Promise<boolean> {
	const hash = parseVoicemailPinHash(digest);
	if (hash === undefined) {
		return false;
	}
	const expected = Buffer.from(hash.hashBase64, "base64");
	const derived = await scrypt(pin, Buffer.from(hash.saltBase64, "base64"), expected.length, {
		N: hash.params.cost,
		r: hash.params.blockSize,
		p: hash.params.parallelism,
		maxmem: scryptMemoryBytes(hash.params) * 2,
	});
	return derived.length === expected.length && timingSafeEqual(derived, expected);
}
