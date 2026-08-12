import { describe, expect, it } from "bun:test";
import { subjectFor } from "@optimiq-voice/events";
import { SipInviteService } from "./sip-invite.service";
import type { EngineEnv } from "../config/engine-env";
import type { JetStreamService } from "./jetstream.service";
import type {
	SipInviteAdmission,
	SipInviteCallPath,
	SipReplacesAuthorization,
} from "./sip-invite.service";
import type { SipInviteRequest } from "@optimiq-voice/events";

/**
 * The transport and policy half of `rpc.sip.v1.invite`, with a fake connection and a fake call path.
 *
 * What is worth proving here and nowhere else:
 *
 * - **Every path ANSWERS.** A silence leaves the edge holding an INVITE server transaction until the
 *   caller's Timer B — thirty-two seconds of nothing before a `503` the caller cannot distinguish
 *   from a dead platform. Each refusal below is a REPLY with a closed reason on it.
 * - **The toll-fraud line holds, and holds EARLY.** A trunk-authenticated INVITE that asked for a
 *   trunk-capable context is refused before the call path is consulted at all, because resolving is
 *   what reads a tenant's plan and a stranger must not be able to probe one by timing.
 * - **`Replaces` refuses by default.** Present is not permission, and an engine that cannot
 *   establish entitlement has not established it.
 *
 * The filing of the leg and the routing walk are the orchestrator's and are tested there.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const TRUNK = "0195c0f0-1c2f-7000-8000-0000000000b2";

function request(overrides: Partial<SipInviteRequest> = {}): SipInviteRequest {
	return {
		legId: "leg-a",
		sipdInstanceId: "sipd-7c9f",
		authentication: "digest",
		routingContext: "internal",
		from: { number: "1001", aor: "sip:1001@acme.example.com" },
		to: { number: "1002" },
		sipCallId: "a84b4c76e66710@pc33.atlanta.com",
		hasOffer: true,
		sdpOffer: "v=0\r\no=- 1 1 IN IP4 203.0.113.7\r\n",
		...overrides,
	} as SipInviteRequest;
}

/** A NATS connection made of two queues, exactly as in `originate.service.spec.ts`. */
function fakeConnection() {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const replies: unknown[] = [];
	const subscribed: { subject: string; queue?: string }[] = [];
	const pending: { data: Uint8Array; reply?: string }[] = [];
	let wake: (() => void) | undefined;

	async function* messages(): AsyncGenerator<{
		data: Uint8Array;
		reply?: string;
		respond: (data: Uint8Array) => void;
	}> {
		for (;;) {
			const next = pending.shift();
			if (next === undefined) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			yield {
				data: next.data,
				...(next.reply === undefined ? {} : { reply: next.reply }),
				respond: (data: Uint8Array) => {
					replies.push(JSON.parse(decoder.decode(data)) as unknown);
				},
			};
		}
	}

	const iterator = messages();
	const connection = {
		subscribe: (subject: string, options?: { queue?: string }) => {
			subscribed.push({
				subject,
				...(options?.queue === undefined ? {} : { queue: options.queue }),
			});
			return { [Symbol.asyncIterator]: () => iterator, unsubscribe: () => undefined };
		},
		isClosed: () => false,
	};

	return {
		connection,
		replies,
		subscribed,
		deliver: async (
			bytes: string,
			options: { readonly reply?: string } = { reply: "_INBOX.test" },
		): Promise<void> => {
			pending.push({
				data: encoder.encode(bytes),
				...(options.reply === undefined ? {} : { reply: options.reply }),
			});
			wake?.();
			wake = undefined;
			for (let tick = 0; tick < 20; tick += 1) {
				await Promise.resolve();
			}
		},
	};
}

const ADMITTED: SipInviteAdmission = {
	kind: "admitted",
	orgId: ORG,
	callId: "call-1",
	legId: "engine-leg-1",
	routingContext: "inbound",
	direction: "inbound",
};

function callPath(
	options: {
		readonly admission?: SipInviteAdmission | "throws";
		readonly replaces?: SipReplacesAuthorization | "throws";
		/** Omit the optional gate entirely — the state an engine with no Replaces support is in. */
		readonly withoutReplacesGate?: boolean;
	} = {},
): {
	readonly path: SipInviteCallPath;
	readonly admits: SipInviteRequest[];
	readonly authorizations: SipInviteRequest[];
} {
	const admits: SipInviteRequest[] = [];
	const authorizations: SipInviteRequest[] = [];
	const admission = options.admission ?? ADMITTED;

	const path: SipInviteCallPath = {
		...(options.withoutReplacesGate === true
			? {}
			: {
					authorizeReplaces: async (received: SipInviteRequest) => {
						authorizations.push(received);
						if (options.replaces === "throws") {
							throw new Error("the registry is on fire");
						}
						return (
							options.replaces ?? { kind: "authorized" as const, replacedLegId: "replaced-leg" }
						);
					},
				}),
		admit: async (received: SipInviteRequest) => {
			admits.push(received);
			if (admission === "throws") {
				throw new Error("the media server is on fire");
			}
			return admission;
		},
	};

	return { path, admits, authorizations };
}

function service(
	fake: ReturnType<typeof fakeConnection>,
	path?: SipInviteCallPath,
): SipInviteService {
	const jetstream = { rawConnection: fake.connection } as unknown as JetStreamService;
	const built = new SipInviteService({ ENGINE_INSTANCE_ID: "engine-1" } as EngineEnv, jetstream);
	if (path !== undefined) {
		built.attach(path);
	}
	built.onApplicationBootstrap();
	return built;
}

describe("the sip invite subscription", () => {
	it("answers on the flat contract subject, queue-grouped so exactly one engine takes the call", () => {
		const fake = fakeConnection();
		const built = service(fake, callPath().path);

		expect(built.subject).toBe(subjectFor.sipInviteRpc());
		expect(fake.subscribed).toEqual([
			{ subject: "rpc.sip.v1.invite", queue: "optimiq-engine-sip-invite" },
		]);
		expect(built.stats.listening).toBe(true);
	});

	it("does not subscribe when the engine has no broker connection", () => {
		const jetstream = { rawConnection: undefined } as unknown as JetStreamService;
		const built = new SipInviteService({ ENGINE_INSTANCE_ID: "engine-1" } as EngineEnv, jetstream);
		built.onApplicationBootstrap();
		expect(built.stats.listening).toBe(false);
	});

	it("subscribes once, however many times Nest bootstraps it", () => {
		const fake = fakeConnection();
		service(fake, callPath().path);
		service(fake, callPath().path);
		expect(fake.subscribed).toHaveLength(2);
	});
});

describe("admitting a call", () => {
	it("replies with the tenant, the call id and the ENGINE's own instance", async () => {
		const fake = fakeConnection();
		const path = callPath();
		const built = service(fake, path.path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies).toEqual([
			{
				ok: true,
				// The EDGE's leg id, echoed. The engine's own domain leg id is derived from it and is
				// deliberately not what goes back: a reply that renamed the leg could not be applied.
				legId: "leg-a",
				orgId: ORG,
				callId: "call-1",
				instanceId: "engine-1",
				routingContext: "inbound",
				direction: "inbound",
			},
		]);
		expect(built.stats.admitted).toBe(1);
	});

	it("hands the whole request to the call path, sipd instance included", async () => {
		const fake = fakeConnection();
		const path = callPath();
		service(fake, path.path);

		await fake.deliver(JSON.stringify(request({ sipdInstanceId: "sipd-2b41" })));

		// Every subsequent command for this leg is addressed at that instance, and this request is the
		// only place the engine ever learns it — there is no directory to look it up in.
		expect(path.admits[0]?.sipdInstanceId).toBe("sipd-2b41");
		expect(path.admits[0]?.sdpOffer).toContain("v=0");
	});

	it("omits routingContext from the reply when the engine did not narrow anything", async () => {
		const fake = fakeConnection();
		service(fake, callPath({ admission: { ...ADMITTED, routingContext: undefined } }).path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).not.toHaveProperty("routingContext");
	});
});

describe("refusing a call", () => {
	it("refuses bytes that are not the contract rather than letting the loop die on them", async () => {
		const fake = fakeConnection();
		const built = service(fake, callPath().path);

		await fake.deliver("{not json");
		await fake.deliver(JSON.stringify({ legId: "leg-a" }));

		expect(fake.replies).toHaveLength(2);
		for (const reply of fake.replies as { ok: boolean; reason: string; instanceId: string }[]) {
			expect(reply.ok).toBe(false);
			expect(reply.reason).toBe("bad_request");
			// Named even here, because on a queue-grouped subject the edge's log is the only place an
			// operator learns WHICH replica is refusing.
			expect(reply.instanceId).toBe("engine-1");
		}
		expect(built.stats.served).toBe(2);
	});

	it("refuses `shutting_down` once draining, so a carrier gets a Retry-After and fails over", async () => {
		const fake = fakeConnection();
		const path = callPath();
		const built = service(fake, path.path);
		built.onApplicationShutdown();

		await fake.deliver(JSON.stringify(request()));

		expect((fake.replies[0] as { reason: string }).reason).toBe("shutting_down");
		expect(path.admits).toHaveLength(0);
		expect(built.stats.listening).toBe(false);
	});

	it("refuses `internal` rather than hanging when no call path is attached yet", async () => {
		const fake = fakeConnection();
		service(fake);

		await fake.deliver(JSON.stringify(request()));

		expect((fake.replies[0] as { reason: string }).reason).toBe("internal");
	});

	it("passes the call path's own refusal through, so the edge picks the right SIP status", async () => {
		const fake = fakeConnection();
		const built = service(
			fake,
			callPath({
				admission: { kind: "refused", reason: "unattributed", error: "no did-index entry" },
			}).path,
		);

		await fake.deliver(JSON.stringify(request({ orgId: undefined })));

		expect(fake.replies).toEqual([
			{
				ok: false,
				legId: "leg-a",
				instanceId: "engine-1",
				reason: "unattributed",
				error: "no did-index entry",
			},
		]);
		expect(built.stats.admitted).toBe(0);
	});

	it("turns a call path that throws into a refusal and keeps serving", async () => {
		const fake = fakeConnection();
		const built = service(fake, callPath({ admission: "throws" }).path);

		await fake.deliver(JSON.stringify(request()));
		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies).toHaveLength(2);
		expect((fake.replies[0] as { reason: string }).reason).toBe("internal");
		expect(built.stats.served).toBe(2);
	});

	it("does not count a request with no reply subject as served", async () => {
		const fake = fakeConnection();
		const built = service(fake, callPath().path);

		await fake.deliver(JSON.stringify(request()), {});

		expect(fake.replies).toHaveLength(0);
		expect(built.stats.served).toBe(0);
	});
});

describe("the toll-fraud boundary", () => {
	for (const context of ["internal", "outbound"]) {
		it(`refuses not_permitted for a trunk-acl INVITE asking to resolve in \`${context}\``, async () => {
			const fake = fakeConnection();
			const path = callPath();
			service(fake, path.path);

			await fake.deliver(
				JSON.stringify(
					request({
						authentication: "trunk-acl",
						routingContext: context,
						trunkId: TRUNK,
						orgId: undefined,
						sourceAddress: "203.0.113.7:5060",
					}),
				),
			);

			const reply = fake.replies[0] as { ok: boolean; reason: string; error: string };
			expect(reply.ok).toBe(false);
			expect(reply.reason).toBe("not_permitted");
			expect(reply.error).toContain(context);
			// BEFORE anything is resolved: resolving reads the tenant's compiled artifact, and doing it
			// for a request that is about to be refused lets a stranger probe a dial plan by timing.
			expect(path.admits).toHaveLength(0);
		});
	}

	it("admits a trunk-acl INVITE that stays in a context which can only reach this tenant's DIDs", async () => {
		const fake = fakeConnection();
		const path = callPath();
		service(fake, path.path);

		await fake.deliver(
			JSON.stringify(
				request({ authentication: "trunk-acl", routingContext: "inbound", trunkId: TRUNK }),
			),
		);

		expect((fake.replies[0] as { ok: boolean }).ok).toBe(true);
		expect(path.admits).toHaveLength(1);
	});

	it("leaves a digest-authenticated extension free to dial out, which is the whole point of the split", async () => {
		const fake = fakeConnection();
		const path = callPath();
		service(fake, path.path);

		await fake.deliver(
			JSON.stringify(request({ authentication: "digest", routingContext: "outbound", orgId: ORG })),
		);

		expect((fake.replies[0] as { ok: boolean }).ok).toBe(true);
		expect(path.admits).toHaveLength(1);
	});
});

describe("an INVITE carrying Replaces", () => {
	const replaces = {
		callId: "consult-call-id@pc33",
		toTag: "farend-tag",
		fromTag: "nearend-tag",
		earlyOnly: false,
	};

	it("refuses when the engine cannot establish entitlement at all", async () => {
		const fake = fakeConnection();
		const path = callPath({ withoutReplacesGate: true });
		service(fake, path.path);

		await fake.deliver(
			JSON.stringify(request({ replaces, replacesLegId: "replaced-leg", orgId: ORG })),
		);

		const reply = fake.replies[0] as { ok: boolean; reason: string };
		expect(reply.ok).toBe(false);
		// An unestablished entitlement is a refusal. Silently dropping the header would route the
		// INVITE as a fresh call and leave the transferor holding a call they believe they handed off.
		expect(reply.reason).toBe("not_permitted");
		expect(path.admits).toHaveLength(0);
	});

	it("refuses when the edge could not resolve the triple to a leg it holds", async () => {
		const fake = fakeConnection();
		const path = callPath();
		service(fake, path.path);

		await fake.deliver(JSON.stringify(request({ replaces, orgId: ORG })));

		expect((fake.replies[0] as { reason: string }).reason).toBe("not_permitted");
		expect(path.authorizations).toHaveLength(0);
		expect(path.admits).toHaveLength(0);
	});

	it("refuses when the caller is not a party to the call the replaced leg belongs to", async () => {
		const fake = fakeConnection();
		const path = callPath({
			replaces: { kind: "refused", error: "that caller is not on the replaced leg's call" },
		});
		service(fake, path.path);

		await fake.deliver(
			JSON.stringify(request({ replaces, replacesLegId: "replaced-leg", orgId: ORG })),
		);

		const reply = fake.replies[0] as { ok: boolean; reason: string; error: string };
		expect(reply.ok).toBe(false);
		expect(reply.reason).toBe("not_permitted");
		expect(reply.error).toContain("not on the replaced leg's call");
		expect(path.admits).toHaveLength(0);
	});

	it("proceeds to admission once entitlement is established, so the call can be re-bridged", async () => {
		const fake = fakeConnection();
		const path = callPath();
		service(fake, path.path);

		await fake.deliver(
			JSON.stringify(request({ replaces, replacesLegId: "replaced-leg", orgId: ORG })),
		);

		expect((fake.replies[0] as { ok: boolean }).ok).toBe(true);
		expect(path.authorizations[0]?.replacesLegId).toBe("replaced-leg");
		// The call path is handed the whole request, `replaces` included, because the re-bridge needs
		// the leg the triple resolved to and nothing else in the engine is holding it.
		expect(path.admits[0]?.replacesLegId).toBe("replaced-leg");
	});

	it("answers `internal` and not `not_permitted` when the gate throws", async () => {
		const fake = fakeConnection();
		const path = callPath({ replaces: "throws" });
		service(fake, path.path);

		await fake.deliver(
			JSON.stringify(request({ replaces, replacesLegId: "replaced-leg", orgId: ORG })),
		);

		// "we decided no" and "we could not decide" are a policy and a bug, and flattening the second
		// into the first is how a defect hides behind a 403.
		expect((fake.replies[0] as { reason: string }).reason).toBe("internal");
		expect(path.admits).toHaveLength(0);
	});

	it("leaves an ordinary INVITE alone — the gate only runs when the header was there", async () => {
		const fake = fakeConnection();
		const path = callPath();
		service(fake, path.path);

		await fake.deliver(JSON.stringify(request()));

		expect(path.authorizations).toHaveLength(0);
		expect((fake.replies[0] as { ok: boolean }).ok).toBe(true);
	});
});
