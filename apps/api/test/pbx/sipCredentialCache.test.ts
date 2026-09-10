import { expect } from "chai";
import {
	affectsSipCredentials,
	changesTheSipRealm,
	SipCredentialCache,
} from "../../src/pbx/sip-credentials/sip-credentials.cache";
import { SipCredentialsService } from "../../src/pbx/sip-credentials/sip-credentials.service";
import type {
	SipAuthEventInput,
	SipAuthEventService,
} from "../../src/pbx/security/sip-auth-event.service";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The credential cache — the thing that took the `rpc.sip.v1.credential` responder from ~510
 * answers/s to a rate the database is not in.
 *
 * The claims worth pinning are not "a map remembers things". They are the four that decide whether
 * this is safe to have at all: a disable takes effect on the COMMIT and not on the TTL, one
 * tenant's key space cannot be reached from another's, a refusal still reaches the attack log after
 * it starts being served from memory, and the map is bounded against the key space an attacker
 * chooses.
 *
 * The database fake is the one `sipCredentials.test.ts` uses — a queue of result sets answered in
 * the order the service issues its selects — extended to COUNT the selects, because "did not go to
 * the database" is the whole assertion here.
 */

const ORG = "019fd3c2-1111-7000-8000-000000000001";
const OTHER_ORG = "019fd3c2-1111-7000-8000-0000000000ff";
const EXTENSION_ID = "019fd3c2-2222-7000-8000-000000000002";
const REALM = "pbx.example.test";
const OTHER_REALM = "other.example.test";
const USERNAME = "1001";
const STORED_HA1 = "0123456789abcdef0123456789abcdef";

interface CountingDatabase {
	readonly client: PbxDatabaseClient;
	/** Every select the service issued, in order. */
	readonly selects: () => number;
}

/** Collects what the service filed in the attack log. */
function fakeAuthEvents(): {
	readonly service: SipAuthEventService;
	readonly recorded: SipAuthEventInput[];
} {
	const recorded: SipAuthEventInput[] = [];
	return {
		recorded,
		service: {
			record: async (input: SipAuthEventInput) => {
				recorded.push(input);
			},
		} as unknown as SipAuthEventService,
	};
}

/**
 * A database that answers the service's four selects for ONE tenant and counts every one of them.
 *
 * `organizationId: undefined` makes the realm unmapped; `extension: undefined` makes the account
 * unknown, which is the negative-caching case.
 */
function oneTenant(options: {
	readonly organizationId?: string;
	readonly extension?: { readonly enabled: boolean; readonly storedHa1?: string | null };
}): CountingDatabase {
	let selects = 0;
	const chain = (rows: unknown[]): Record<string, unknown> => {
		const self: Record<string, unknown> = {};
		for (const method of ["from", "leftJoin", "innerJoin", "where", "orderBy"]) {
			self[method] = () => self;
		}
		self.limit = async () => rows;
		return self;
	};

	const adminSelect = () => {
		selects += 1;
		return chain(
			options.organizationId === undefined ? [] : [{ organizationId: options.organizationId }],
		);
	};

	// Per tenant-scope round: device line (none), extension, appearance (none).
	let step = 0;
	const tenantSelect = () => {
		selects += 1;
		const which = step % 3;
		step += 1;
		if (which === 1 && options.extension !== undefined) {
			return chain([
				{
					id: EXTENSION_ID,
					enabled: options.extension.enabled,
					secretRef: "secret-ref",
					storedHa1:
						options.extension.storedHa1 === undefined ? STORED_HA1 : options.extension.storedHa1,
				},
			]);
		}
		return chain([]);
	};

	return {
		selects: () => selects,
		client: {
			adminDb: { select: adminSelect },
			withTenantScope: async <T>(_organizationId: string, work: (tx: never) => Promise<T>) =>
				await work({ select: tenantSelect } as never),
		} as unknown as PbxDatabaseClient,
	};
}

function serviceOn(
	database: CountingDatabase,
	cache: SipCredentialCache,
	events = fakeAuthEvents(),
): { readonly service: SipCredentialsService; readonly events: ReturnType<typeof fakeAuthEvents> } {
	return {
		service: new SipCredentialsService(database.client, events.service, cache),
		events,
	};
}

describe("SipCredentialCache", () => {
	it("answers a repeated lookup without touching the database", async () => {
		const database = oneTenant({ organizationId: ORG, extension: { enabled: true } });
		const cache = new SipCredentialCache();
		const { service } = serviceOn(database, cache);

		const first = await service.resolve({ realm: REALM, username: USERNAME });
		const afterMiss = database.selects();
		const second = await service.resolve({ realm: REALM, username: USERNAME });

		expect(first.ha1).to.equal(STORED_HA1);
		expect(second).to.deep.equal(first);
		expect(afterMiss).to.be.greaterThan(0);
		// Not one fewer query — NONE. The realm directory is cached too.
		expect(database.selects()).to.equal(afterMiss);
		expect(cache.stats.hits).to.equal(1);
		expect(cache.stats.misses).to.equal(1);
	});

	it("goes back to the database after the entry is invalidated", async () => {
		const database = oneTenant({ organizationId: ORG, extension: { enabled: true } });
		const cache = new SipCredentialCache();
		const { service } = serviceOn(database, cache);

		await service.resolve({ realm: REALM, username: USERNAME });
		const afterMiss = database.selects();
		cache.invalidate(ORG, "update on extension");
		await service.resolve({ realm: REALM, username: USERNAME });

		expect(database.selects()).to.be.greaterThan(afterMiss);
	});

	it("announces the invalidation to whoever registered a publisher", () => {
		const cache = new SipCredentialCache();
		const announced: { organizationId: string; reason: string; dropped: number }[] = [];
		cache.setAnnouncer((organizationId, reason, dropped) => {
			announced.push({ organizationId, reason, dropped });
		});
		cache.remember(ORG, REALM, USERNAME, { found: true, enabled: true, ha1: STORED_HA1 });

		cache.invalidate(ORG, "update on extension");

		expect(announced).to.have.length(1);
		expect(announced[0]?.organizationId).to.equal(ORG);
		expect(announced[0]?.reason).to.equal("update on extension");
		expect(announced[0]?.dropped).to.equal(1);
	});

	it("expires a positive entry on its TTL", async () => {
		const database = oneTenant({ organizationId: ORG, extension: { enabled: true } });
		const cache = new SipCredentialCache();
		let now = 1_000_000;
		cache.setClock(() => now);
		const { service } = serviceOn(database, cache);

		await service.resolve({ realm: REALM, username: USERNAME });
		const afterMiss = database.selects();
		now += 59_000;
		await service.resolve({ realm: REALM, username: USERNAME });
		expect(database.selects()).to.equal(afterMiss);

		now += 2_000;
		await service.resolve({ realm: REALM, username: USERNAME });
		expect(database.selects()).to.be.greaterThan(afterMiss);
	});

	it("caches an unknown account briefly, and keeps filing every attempt in the attack log", async () => {
		const database = oneTenant({ organizationId: ORG });
		const cache = new SipCredentialCache();
		let now = 1_000_000;
		cache.setClock(() => now);
		const { service, events } = serviceOn(database, cache);

		const first = await service.resolve({
			realm: REALM,
			username: "9999",
			sourceAddress: "203.0.113.9:5060",
		});
		const afterMiss = database.selects();
		const second = await service.resolve({
			realm: REALM,
			username: "9999",
			sourceAddress: "203.0.113.9:5060",
		});

		expect(first.found).to.equal(false);
		expect(second.found).to.equal(false);
		expect(database.selects()).to.equal(afterMiss);
		// The cache removes the QUERIES, never the security record: a spray that stopped being
		// counted after its first packet would be a spray nobody could see.
		expect(events.recorded).to.have.length(2);
		expect(events.recorded[1]?.eventType).to.equal("unknown-account");
		expect(events.recorded[1]?.sourceIp).to.equal("203.0.113.9");

		// And it is held for five seconds, not for the positive minute.
		now += 6_000;
		await service.resolve({ realm: REALM, username: "9999" });
		expect(database.selects()).to.be.greaterThan(afterMiss);
	});

	it("keeps recording a disabled account after the answer starts coming from memory", async () => {
		const database = oneTenant({ organizationId: ORG, extension: { enabled: false } });
		const cache = new SipCredentialCache();
		const { service, events } = serviceOn(database, cache);

		await service.resolve({ realm: REALM, username: USERNAME });
		const afterMiss = database.selects();
		const second = await service.resolve({ realm: REALM, username: USERNAME });

		expect(second.found).to.equal(true);
		expect(second.enabled).to.equal(false);
		expect(database.selects()).to.equal(afterMiss);
		expect(events.recorded.map((event) => event.eventType)).to.deep.equal([
			"disabled-account",
			"disabled-account",
		]);
	});

	it("does not cache a deployment failure", async () => {
		// An enabled extension with no STORED digest, and no root key to derive one from: the
		// service refuses with "PROVISION_SIP_SECRET_KEY is not configured". That refusal is about
		// the DEPLOYMENT, not about the account, and remembering it would keep a whole fleet refused
		// for a minute after an operator set the variable and restarted.
		const previous = process.env.PROVISION_SIP_SECRET_KEY;
		delete process.env.PROVISION_SIP_SECRET_KEY;
		try {
			const database = oneTenant({
				organizationId: ORG,
				extension: { enabled: true, storedHa1: null },
			});
			const cache = new SipCredentialCache();
			const { service } = serviceOn(database, cache);

			const reply = await service.resolve({ realm: REALM, username: USERNAME });
			expect(reply.found).to.equal(false);
			expect(reply.reason).to.contain("PROVISION_SIP_SECRET_KEY");
			expect(cache.lookup(ORG, REALM, USERNAME)).to.equal(undefined);
			expect(cache.stats.size).to.equal(0);
		} finally {
			if (previous !== undefined) {
				process.env.PROVISION_SIP_SECRET_KEY = previous;
			}
		}
	});

	it("keeps one tenant's key space out of another's", () => {
		const cache = new SipCredentialCache();
		cache.remember(ORG, REALM, USERNAME, { found: true, enabled: true, ha1: STORED_HA1 });
		cache.remember(OTHER_ORG, OTHER_REALM, USERNAME, {
			found: true,
			enabled: true,
			ha1: "ffffffffffffffffffffffffffffffff",
		});

		// The same username in two tenants is two entries, and neither reaches the other's digest.
		expect(cache.lookup(ORG, REALM, USERNAME)?.ha1).to.equal(STORED_HA1);
		expect(cache.lookup(OTHER_ORG, OTHER_REALM, USERNAME)?.ha1).to.equal(
			"ffffffffffffffffffffffffffffffff",
		);
		expect(cache.lookup(ORG, OTHER_REALM, USERNAME)).to.equal(undefined);
		expect(cache.lookup(OTHER_ORG, REALM, USERNAME)).to.equal(undefined);

		// And an invalidation of one tenant leaves the other's entries alone.
		cache.invalidate(ORG, "remove on extension");
		expect(cache.lookup(ORG, REALM, USERNAME)).to.equal(undefined);
		expect(cache.lookup(OTHER_ORG, OTHER_REALM, USERNAME)?.ha1).to.equal(
			"ffffffffffffffffffffffffffffffff",
		);
	});

	it("cannot be made to collide by a realm or a username containing the separator", () => {
		const cache = new SipCredentialCache();
		cache.remember(ORG, "a", "b c", { found: true, enabled: true, ha1: STORED_HA1 });
		expect(cache.lookup(ORG, "a b", "c")).to.equal(undefined);
	});

	it("drops the realm directory when the realm itself may have moved", async () => {
		const database = oneTenant({ organizationId: ORG, extension: { enabled: true } });
		const cache = new SipCredentialCache();
		const { service } = serviceOn(database, cache);

		await service.resolve({ realm: REALM, username: USERNAME });
		expect(cache.stats.realms).to.equal(1);

		cache.invalidate(ORG, "update on org_setting", { realmDirectory: true });
		expect(cache.stats.realms).to.equal(0);
	});

	it("caches an unmapped realm on the short TTL", async () => {
		const database = oneTenant({});
		const cache = new SipCredentialCache();
		let now = 1_000_000;
		cache.setClock(() => now);
		const { service } = serviceOn(database, cache);

		const first = await service.resolve({ realm: REALM, username: USERNAME });
		expect(first.found).to.equal(false);
		expect(first.reason).to.contain("no organization is mapped");
		const afterMiss = database.selects();

		await service.resolve({ realm: REALM, username: USERNAME });
		expect(database.selects()).to.equal(afterMiss);

		now += 6_000;
		await service.resolve({ realm: REALM, username: USERNAME });
		expect(database.selects()).to.be.greaterThan(afterMiss);
	});

	it("is bounded, and sheds the entries nothing is asking for", () => {
		const cache = new SipCredentialCache();
		// One over the cap, so exactly one eviction is forced and the survivor set is observable.
		for (let index = 0; index < 20_001; index += 1) {
			cache.remember(ORG, REALM, `spray-${index}`, { found: false, enabled: false });
		}

		expect(cache.stats.size).to.equal(20_000);
		expect(cache.stats.evicted).to.equal(1);
		// The oldest went; the newest stayed.
		expect(cache.lookup(ORG, REALM, "spray-0")).to.equal(undefined);
		expect(cache.lookup(ORG, REALM, "spray-20000")).to.not.equal(undefined);
	});
});

describe("the mutation seam's predicates", () => {
	it("names every table that can change a credential answer", () => {
		for (const table of [
			"extension",
			"device",
			"device_line",
			"shared_line",
			"shared_line_appearance",
			"org_setting",
		]) {
			expect(affectsSipCredentials(table), table).to.equal(true);
		}
	});

	it("leaves the tables that cannot alone", () => {
		for (const table of ["trunk", "queue", "queue_agent", "sip_acl_entry", "phone_number"]) {
			expect(affectsSipCredentials(table), table).to.equal(false);
		}
	});

	it("treats an org_setting write, and only that, as a possible realm move", () => {
		expect(changesTheSipRealm("org_setting")).to.equal(true);
		expect(changesTheSipRealm("extension")).to.equal(false);
	});
});
