import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { runEffect } from "@optimiq-voice/effect-runtime";
import { actorFromSession } from "../shared/audit-log";
import { toWireDiagnostic } from "../shared/pbx.errors";
import { PBX_EFFECT_RUNTIME } from "../shared/pbx.tokens";
import { hashVoicemailPin } from "../voicemail-boxes/voicemail-pin.service";
import { CONFERENCE_RESOURCE } from "./conferences.resource";
import type { MutationEnvelope } from "../shared/pbx-resource.service";
import type { PbxRepositoryRuntime } from "../shared/pbx-runtime";
import type { AppSession } from "@optimiq-voice/auth";

/** Which of a room's two PINs an endpoint is setting. */
export type ConferencePinRole = "participant" | "moderator";

/**
 * A conference room's PINs.
 *
 * ## The endpoint `conferences.resource.ts` has been promising since the resource was declared
 *
 * That file records the gap in as many words: *"`pinHash` and `moderatorPinHash` are absent from the
 * DTO, exactly as `voicemail_box.pinHash` is: a PIN is set through an endpoint that hashes it, never
 * by an admin pasting a digest into a JSON body. Until that endpoint exists, `requiresPin` in the
 * compiled artifact stays false."* This is that endpoint, and it is a deliberate copy of
 * `voicemail-pin.service.ts` down to the digest format.
 *
 * ## The same digest, and why not a second one
 *
 * `packages/routing` owns ONE PIN digest format — `scrypt$N=…,r=…,p=…$<salt>$<hash>` — and owns it
 * without a KDF, because giving a pure compiler one would put scrypt on the import graph of the
 * resolver. `hashVoicemailPin` is the API's implementation of the writing half, and it is imported
 * here rather than reimplemented. A second format for conference PINs would be a second set of
 * scrypt parameters to keep in step, a second parser in the engine, and a second chance for one of
 * them to get the constant-time compare wrong.
 *
 * The function's NAME still says "voicemail" and that is left alone on purpose: renaming it would
 * touch `verify-pbx.ts`, `verify-voicemail.ts` and the engine-side comments that reference it, for
 * a change that improves nothing. What matters is the format, and the format is
 * `packages/routing`'s.
 *
 * ## The PIN policy is the mailbox's policy, minus one rule
 *
 * See `conferences.dto.ts`. Digits only and 4–10 of them, for the same reason: a conference PIN is
 * entered on a telephone keypad and terminated by `#`. The weak-shape blocklist (a single repeated
 * digit, a straight run) is applied too — with three attempts per call, a PIN from the handful an
 * attacker tries first is materially weaker than one that is not.
 *
 * ## What reaches the engine, and what does not — read this before believing a PIN is enforced
 *
 * `apps/api/src/pbx/routing/snapshot-loader.ts` projects the conference row onto
 * `ConferenceInput` as `requiresPin: row.pinHash !== null`. So setting a participant PIN through
 * this service DOES change the compiled artifact — `ConferencePlanNode.requiresPin` flips to true,
 * the `snapshotHash` moves, and the engine learns that the room challenges for a PIN.
 *
 * Two things do NOT reach the engine today, and neither can be fixed from this app:
 *
 * 1. **The digest itself.** `ConferenceInput` and `ConferencePlanNode` in `packages/routing` carry
 *    no `pinHash` field, so there is nothing for the loader to put it in. The engine can therefore
 *    know that a room wants a PIN and cannot verify one. `VoicemailPlanNode.pinHash` is the shape
 *    it needs, and adding the equivalent to the conference node is a change in `packages/routing`
 *    (`snapshot.ts`, `plan.ts`, `compile.ts` — an optional field, so no artifact-version bump per
 *    that package's README §2.1).
 * 2. **The moderator PIN, at all.** The loader drops `moderator_pin_hash` and there is no
 *    `requiresModeratorPin` on `ConferenceInput`. Setting or clearing a moderator PIN therefore
 *    recompiles the tenant and produces an artifact with an IDENTICAL `snapshotHash` — a provable
 *    no-op, which `isArtifactFresh` correctly skips publishing. The column is written and stored;
 *    nothing downstream reads it yet.
 *
 * Both are recorded rather than faked. Writing the digest into a field the compiler does not
 * declare is not possible (the loader's projection is type-checked against `ConferenceInput`), and
 * pretending otherwise would produce a UI that says a room is protected when it is not.
 */
@Injectable()
export class ConferencePinService {
	constructor(@Inject(PBX_EFFECT_RUNTIME) private readonly runtime: PbxRepositoryRuntime) {}

	/**
	 * Sets one of the room's PINs.
	 *
	 * A `POST` on a room that already has one replaces it. There is no "verify the old one first"
	 * step, on exactly the terms `voicemail-boxes.controller.ts` sets out: this is an administrator
	 * configuring a room, not a participant changing their own credential, and demanding a PIN the
	 * administrator does not know would make the endpoint useless for the case it exists to serve.
	 */
	async set(
		session: AppSession,
		id: string,
		role: ConferencePinRole,
		pin: string,
	): Promise<MutationEnvelope<ConferencePinState>> {
		return await this.write(session, id, role, await hashVoicemailPin(pin));
	}

	/**
	 * Clears it.
	 *
	 * Clearing the PARTICIPANT PIN opens the room to anyone who can dial its number, which is what
	 * it was before a PIN was ever set — a downgrade rather than a lockout, and why it is a
	 * `conferences.write` rather than a `conferences.delete`.
	 *
	 * Clearing the MODERATOR PIN on a room with `waitForModerator` on is the one combination worth
	 * naming: participants would be held in music-on-hold with no way for anybody to release them.
	 * It is not refused here — the compiler is free to warn about it and this layer has no business
	 * guessing at a configuration, which is the same line `conferences.dto.ts` draws about
	 * `waitForModerator` itself — and the web dialog says so before the button is pressed.
	 */
	async clear(
		session: AppSession,
		id: string,
		role: ConferencePinRole,
	): Promise<MutationEnvelope<ConferencePinState>> {
		return await this.write(session, id, role, null);
	}

	/**
	 * The write, through the SAME repository `update` every other mutation uses.
	 *
	 * That is what makes the digest reach the engine at all: `conference` is a routing table, so
	 * `repository.update` runs compile-on-write inside the write transaction and the module's
	 * `onArtifactCompiled` seam publishes the artifact afterwards. A direct write on the database
	 * client — which is how `voicemail-consumer.service.ts` files messages, and correct there
	 * because `affectsRouting("voicemail_message")` is false — would leave the compiled artifact
	 * saying `requiresPin: false` until something unrelated recompiled the tenant.
	 */
	private async write(
		session: AppSession,
		id: string,
		role: ConferencePinRole,
		pinHash: string | null,
	): Promise<MutationEnvelope<ConferencePinState>> {
		const organizationId = requireActiveOrganizationId(session);
		const column = role === "moderator" ? "moderatorPinHash" : "pinHash";
		const result = await runEffect(this.runtime, (repository) =>
			repository.update(
				organizationId,
				CONFERENCE_RESOURCE,
				id,
				{ [column]: pinHash },
				actorFromSession(session),
			),
		);
		const row = result.row as {
			readonly id: string;
			readonly roomNumber: string;
			readonly pinHash: string | null;
			readonly moderatorPinHash: string | null;
		};
		return {
			// Both flags on every reply, so a dialog that just set one does not have to re-fetch to
			// render the other. Never a digest, and never the PIN — `secretColumns` on the resource
			// strips the columns from every normal response and this endpoint answers in booleans.
			data: {
				id: row.id,
				roomNumber: row.roomNumber,
				pinSet: row.pinHash !== null,
				moderatorPinSet: row.moderatorPinHash !== null,
			},
			warnings: result.warnings.map(toWireDiagnostic),
		};
	}
}

export interface ConferencePinState {
	readonly id: string;
	readonly roomNumber: string;
	/** Whether the room now challenges participants. This IS reflected in the compiled artifact. */
	readonly pinSet: boolean;
	/**
	 * Whether a moderator PIN is stored.
	 *
	 * Stored only. Nothing downstream reads it yet — see the class doc — so a `true` here means the
	 * column is set, not that the engine will challenge for it.
	 */
	readonly moderatorPinSet: boolean;
}
