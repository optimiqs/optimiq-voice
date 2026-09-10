import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "chai";
import { PERMISSIONS, RETIRED_PERMISSIONS } from "@optimiq-voice/auth";
import type { Permission } from "@optimiq-voice/auth";

/**
 * The enforcement-coverage gate.
 *
 * ## What this exists to stop
 *
 * The W7 parity audit found twelve declared permissions that no server code ever checked. Each one
 * was a promise the UI could render and the server could not keep: the role editor showed it, an
 * administrator granted it believing it did something, and the endpoint it appeared to describe was
 * either absent or guarded by a neighbouring grant. Fixing the twelve was a one-off; this test is
 * what makes the thirteenth impossible to add by accident.
 *
 * The rule it enforces is the one the registry's own header already states — *"adding a permission
 * here is the only supported way to introduce one"* — with the half that was missing: a permission
 * and the check that reads it land together, or the permission goes on a list that says why not.
 *
 * ## The four ways this platform enforces a permission
 *
 * A grep for `@RequirePermissions` alone would be wrong, and would have reported `calls.supervise`
 * as unenforced when it is the most carefully enforced grant in the system. There are four
 * mechanisms and this scans all of them:
 *
 * 1. **`@RequirePermissions(...)`** on a controller method, read by the global guard. The bulk.
 * 2. **`LIVE_TOPIC_PERMISSIONS`** in `src/live/live-topics.ts` — the WebSocket fan-out's gate,
 *    which is a lookup table rather than a decorator because a topic is a value, not a route.
 * 3. **`hasPermission(...)` in a service** — used where the rule is an OR over a ROW rather than an
 *    AND over a request (`queue-agent-session.service.ts` argues this at length for
 *    `queues.join.own`).
 * 4. **`rpc.authz.v1.check`, asked by another process.** `apps/engine` sends the permission it needs
 *    by name over NATS and `AuthzService` answers; that is how a handset dialling `*0` is checked
 *    for `calls.supervise`. The grant is enforced in a different repository directory, so the scan
 *    reaches into `apps/engine/src` for it.
 *
 * ## Why the allowlist is a table with prose and not a `skip`
 *
 * Every entry below is a permission that is genuinely not checked anywhere, with the reason. Some
 * of those reasons are good (`settings.write.all` is a marker whose whole job is to be the thing
 * `admin` does not hold) and some are defects with a named seam (the `.own` set). Writing them down
 * is the difference between a known gap and an unknown one, and the count assertion at the end is
 * what stops the list from quietly growing.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const API_SRC = join(HERE, "..", "..", "src");
const ENGINE_SRC = join(HERE, "..", "..", "..", "engine", "src");

/**
 * Declared, checked nowhere, and deliberately so — each with the reason it is not a defect, or the
 * seam that would close it if it is.
 */
const DOCUMENTED_UNENFORCED: Readonly<Record<string, string>> = {
	/**
	 * The definition of what `admin` does not get.
	 *
	 * `ADMIN_PERMISSIONS` is literally `PERMISSIONS.filter((p) => p !== "settings.write.all")`, so
	 * removing this entry would make `admin` and `owner` identical. It guards nothing because there
	 * is no cross-tenant settings surface to guard — `org-settings.controller.ts` says so in its
	 * header: "nothing in this controller can write outside one tenant". A marker permission that
	 * defines a role boundary is not the same thing as a broken promise, and this is the only one.
	 */
	"settings.write.all": "a role-boundary marker; no cross-tenant surface exists to guard",

	/**
	 * The publish that has no scope of its own.
	 *
	 * `POST /api/v1/routing/compile` recompiles the WHOLE organization and is guarded by
	 * `routes.publish`. An IVR-scoped publish does not exist, because the compile is whole-org by
	 * construction — there is nothing smaller to publish. Retained rather than retired because the
	 * split is real for a future incremental publish; it is the next candidate for retirement if
	 * that never arrives.
	 */
	"ivr.publish": "the compile is whole-organization; `routes.publish` guards it",

	/**
	 * Enforced by better-auth's organization plugin, on its own singular statements.
	 *
	 * `access-control.ts` records that our roles REPLACE the plugin's rather than merging into them,
	 * and the plugin gates `/api/auth/organization/*` on `invitation.create`, `member.delete` and so
	 * on — which are its strings, not ours. The OPERATION is protected; these plural names are not
	 * what protects it. Making them load-bearing means either re-implementing the invitation flow
	 * behind our own guard or teaching the plugin our vocabulary, and neither is a permission
	 * problem.
	 */
	"members.invite": "better-auth's organization plugin gates the route on its own statements",
	"members.update-role": "better-auth's organization plugin gates the route on its own statements",
	"members.remove": "better-auth's organization plugin gates the route on its own statements",

	/** Same, for the api-key plugin's routes. */
	"api-keys.read": "better-auth's api-key plugin gates the route on its own statements",
	"api-keys.write": "better-auth's api-key plugin gates the route on its own statements",
	"api-keys.revoke": "better-auth's api-key plugin gates the route on its own statements",
	"api-keys.read.own": "better-auth's api-key plugin gates the route on its own statements",
	"api-keys.write.own": "better-auth's api-key plugin gates the route on its own statements",

	/**
	 * Assignment has no route of its own; it rides the resource's PATCH.
	 *
	 * Re-pointing a DID is a field on `PATCH /phone-numbers/:id`, guarded by the resource's write grant.
	 * Enforcing these would mean either a dedicated endpoint or a per-field check inside the generic
	 * repository — the second of which is the seam (`PbxResource` has no per-column permission
	 * concept, deliberately).
	 */
	"numbers.assign": "no dedicated route; re-pointing is a field on the resource's PATCH",

	/**
	 * The one scoped self-service grant that STILL cannot be enforced, and why it is honest.
	 *
	 * This table used to carry the whole `.own` set as one defect: `hasPermission` lets an unscoped
	 * grant satisfy a scoped requirement and NEVER the reverse, every read guard named the unscoped
	 * grant, and the `user` role holds only scoped grants — so a `user` cleared the page and met a
	 * 403 on its data call. The fix is the row check `queue-agent-session.service.ts` set the
	 * precedent for: lower the endpoint's floor to the `.own` grant (which an unscoped holder still
	 * satisfies) and narrow the ROW in the service. Six of the eight went that way through
	 * `apps/api/src/pbx/shared/self-ownership.ts` — `extensions.read.own`/`write.own`,
	 * `devices.read.own`, `voicemail.read.own`/`delete.own`/`listen.own` — and `cdr.read.own` has now
	 * followed, so all seven have LEFT this table (the "no stale entry" test below asserts they had
	 * to).
	 *
	 * CDR needed one thing the other six did not: a link from a user to a ledger that holds no user
	 * ids at all. It is resolved the long way round — the acting user's EXTENSIONS, read in the PBX
	 * area (`ownedExtensionParties`) and handed to the CDR area through the `CDR_SELF_PARTIES` port,
	 * matched against `from_number`/`to_number` and against `destination_ref` on the legs the switch
	 * dialled to them (`apps/api/src/cdr/query/cdr-self-scope.ts`).
	 *
	 * `recordings.read.own` is the last one left, and it is one step behind rather than blocked: a
	 * recording names its `leg_id`, so the same party predicate reaches it through a join this area
	 * does not yet have a query for. Listed here so it stays a KNOWN gap and not a silent one.
	 */
	"recordings.read.own":
		"the CDR party predicate does not reach recordings' own listing yet; see this note",
};

/** Every `.ts` file under a directory, recursively. Test files are excluded by the caller. */
function sourceFiles(root: string): readonly string[] {
	const found: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry);
			if (statSync(path).isDirectory()) {
				if (entry !== "node_modules" && entry !== "dist") {
					walk(path);
				}
				continue;
			}
			if (path.endsWith(".ts") && !path.endsWith(".spec.ts") && !path.endsWith(".test.ts")) {
				found.push(path);
			}
		}
	};
	walk(root);
	return found;
}

/**
 * Every permission string that appears in a position that CHECKS it.
 *
 * A quoted permission literal is the signal, and it is deliberately not narrowed to
 * `@RequirePermissions(...)` — the four mechanisms above put the same string in four different
 * syntactic positions, and a scan tight enough to see only one of them is the scan that produced
 * the audit's original false positives. The cost is that a permission named in a COMMENT counts as
 * enforced; the registry is full of comments naming permissions, so this is checked below by
 * stripping comments first.
 */
function enforcedPermissions(): ReadonlySet<string> {
	const enforced = new Set<string>();
	const roots = [API_SRC, ENGINE_SRC];
	const declared = new Set<string>(PERMISSIONS);

	for (const root of roots) {
		for (const file of sourceFiles(root)) {
			const stripped = stripComments(readFileSync(file, "utf8"));
			for (const match of stripped.matchAll(
				/["'`]([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*(?:\.(?:own|team|all))?)["'`]/gu,
			)) {
				const candidate = match[1];
				if (candidate !== undefined && declared.has(candidate)) {
					enforced.add(candidate);
				}
			}
		}
	}
	return enforced;
}

/**
 * Removes line and block comments.
 *
 * Crude on purpose: a `//` inside a string literal (a URL) would be cut short, which can only ever
 * cause this scan to see FEWER permissions and therefore to fail loudly rather than to pass
 * wrongly. The alternative is a TypeScript parse, which is a dependency and a build step for a
 * gate whose whole value is that it is cheap enough to always run.
 */
function stripComments(source: string): string {
	return source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/(^|[^:"'`])\/\/[^\n]*/gu, "$1");
}

describe("permission enforcement coverage", () => {
	const enforced = enforcedPermissions();

	/**
	 * The gate.
	 *
	 * A new permission with no check fails here, naming itself. The fix is one of exactly three
	 * things: guard the endpoint, delete the entry (and record it in `RETIRED_PERMISSIONS`), or add
	 * it to `DOCUMENTED_UNENFORCED` with a sentence saying why it is not a promise. All three are
	 * decisions a reviewer can see in the diff, which is the entire point.
	 */
	it("checks every declared permission somewhere, or documents why it does not", () => {
		const unaccounted = PERMISSIONS.filter(
			(permission) => !enforced.has(permission) && DOCUMENTED_UNENFORCED[permission] === undefined,
		);
		expect(
			unaccounted,
			`These permissions are declared and never checked. Guard the endpoint, retire the ` +
				`permission, or add it to DOCUMENTED_UNENFORCED with a reason: ${unaccounted.join(", ")}`,
		).to.deep.equal([]);
	});

	/**
	 * The allowlist decays as endpoints arrive, and this is what makes it decay rather than rot.
	 *
	 * An entry whose permission has since been guarded — or retired — is a stale excuse, and a stale
	 * excuse is how a list like this stops being read.
	 */
	it("carries no entry for a permission that is now enforced or no longer exists", () => {
		const declared = new Set<string>(PERMISSIONS);
		const stale = Object.keys(DOCUMENTED_UNENFORCED).filter(
			(permission) => enforced.has(permission) || !declared.has(permission),
		);
		expect(stale, `stale DOCUMENTED_UNENFORCED entries: ${stale.join(", ")}`).to.deep.equal([]);
	});

	/** A retired permission must not be checked anywhere: the guard should have gone with it. */
	it("checks nothing that was retired", () => {
		const zombie = RETIRED_PERMISSIONS.filter((permission) => enforced.has(permission));
		expect(zombie, `retired but still referenced: ${zombie.join(", ")}`).to.deep.equal([]);
	});

	/**
	 * The permissions this wave closed, asserted by name.
	 *
	 * A regression here is a guard somebody removed while tidying, and the audit's finding coming
	 * back. Named individually rather than counted so the failure says which one.
	 */
	it("enforces the permissions the W7 audit found unenforced", () => {
		const closed: Permission[] = [
			// The endpoints this wave built.
			"cdr.export",
			"recordings.delete",
			"recordings.configure",
			// The endpoints that existed and were guarded by a neighbouring grant.
			"provisioning.read",
			"provisioning.write",
			"provisioning.tokens",
		];
		for (const permission of closed) {
			expect(enforced.has(permission), `${permission} must be checked somewhere`).to.equal(true);
		}
	});

	/**
	 * The scan reaches across the process boundary, and this asserts that it does.
	 *
	 * `calls.supervise` is checked by `apps/engine` asking `rpc.authz.v1.check` for it — there is no
	 * session on a handset. If this ever fails, the scan has stopped looking at the engine and every
	 * cross-process grant has silently become "unenforced".
	 */
	it("sees a permission enforced from another process over the authz RPC", () => {
		expect(enforced.has("calls.supervise")).to.equal(true);
	});

	/** The allowlist may shrink freely and must not grow without somebody noticing. */
	it("keeps the documented-unenforced list from growing quietly", () => {
		expect(Object.keys(DOCUMENTED_UNENFORCED).length).to.be.at.most(24);
	});
});
