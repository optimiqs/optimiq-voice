import { BadRequestException } from "@nestjs/common";
import { expect } from "chai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTestModuleRuntime } from "@optimiq-voice/effect-runtime";
import { PbxRepository } from "../../src/pbx/shared/pbx.repository";
import { createWebhookDto, updateWebhookDto } from "../../src/pbx/webhooks/webhooks.dto";
import { WEBHOOK_SUBSCRIPTION_RESOURCE } from "../../src/pbx/webhooks/webhooks.resource";
import { WebhooksService } from "../../src/pbx/webhooks/webhooks.service";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { PbxRepositoryRuntime } from "../../src/pbx/shared/pbx-runtime";
import type { PbxRepositoryInterface } from "../../src/pbx/shared/pbx.repository";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * The webhook slice's two departures from generic CRUD — the write-only secret and the revival on
 * re-enable — plus the DTO's refusals.
 *
 * Everything else about this resource is the shared machinery, and `pbxResourceService.test.ts`
 * already proves that. What is only true here is that a signing key leaves the process exactly once
 * and that turning a dead endpoint back on is a complete recovery rather than a half of one.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";

function sessionFor(organizationId: string | null): AppSession {
	return {
		session: {
			id: "sess",
			userId: "019fd3c2-2222-76be-a6b3-b0f1914e39b6",
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: organizationId,
		},
		user: { id: "u", email: "u@test", name: "U", emailVerified: true },
	} as AppSession;
}

interface Recorded {
	readonly method: string;
	readonly args: readonly unknown[];
}

/** The repository, faked; the row it returns carries a secret so redaction is observable. */
function fakeRuntime(): { runtime: PbxRepositoryRuntime; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const record =
		<A>(method: string, result: () => Effect.Effect<A, never>) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
			return result();
		};
	const row = { id: "webhook-1", url: "https://example.test/hook", secret: "whsec_stored" };
	const repository = {
		list: record("list", () =>
			Effect.succeed({ data: [row], total: 1, page: 1, limit: 20, totalPages: 1 }),
		),
		get: record("get", () => Effect.succeed(row)),
		create: record("create", () => Effect.succeed({ row, warnings: [] })),
		update: record("update", () => Effect.succeed({ row, warnings: [] })),
		remove: record("remove", () => Effect.succeed({ row: { id: "webhook-1" }, warnings: [] })),
		listChildren: record("listChildren", () =>
			Effect.succeed({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
		),
		createChild: record("createChild", () => Effect.succeed({ row, warnings: [] })),
		updateChild: record("updateChild", () => Effect.succeed({ row, warnings: [] })),
		removeChild: record("removeChild", () =>
			Effect.succeed({ row: { id: "webhook-1" }, warnings: [] }),
		),
		reorderChildren: record("reorderChildren", () => Effect.succeed({ row: [], warnings: [] })),
		compile: record("compile", () => Effect.succeed({ warnings: [] })),
	} as unknown as PbxRepositoryInterface;

	const layer = Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(repository)));
	return { runtime: makeTestModuleRuntime(PbxRepository, layer), calls };
}

function serviceWith(overrides: Partial<PbxEnv> = {}): {
	service: WebhooksService;
	calls: Recorded[];
} {
	const { runtime, calls } = fakeRuntime();
	const env = { PBX_WEBHOOK_ALLOW_INSECURE_URLS: false, ...overrides } as PbxEnv;
	return { service: new WebhooksService(runtime, env), calls };
}

const VALID = {
	url: "https://example.test/hook",
	eventSelectors: ["calls.evt.v1.>"],
};

describe("the webhook resource", () => {
	it("declares the signing key as a secret column, so it is redacted on every read", () => {
		expect(WEBHOOK_SUBSCRIPTION_RESOURCE.secretColumns).to.deep.equal(["secret"]);
		expect(WEBHOOK_SUBSCRIPTION_RESOURCE.kind).to.equal("webhook");
		expect(WEBHOOK_SUBSCRIPTION_RESOURCE.tableName).to.equal("webhook_subscription");
	});

	it("points at nothing and is pointed at by nothing, so a delete can never orphan a row", () => {
		expect(WEBHOOK_SUBSCRIPTION_RESOURCE.destinations).to.deep.equal([]);
		expect(WEBHOOK_SUBSCRIPTION_RESOURCE.destinationType).to.equal(null);
	});
});

describe("WebhooksService", () => {
	it("generates a secret when none was supplied, and returns it exactly once", async () => {
		const { service, calls } = serviceWith();

		const created = await service.create(sessionFor(ORGANIZATION_ID), { ...VALID });

		const written = calls[0]?.args[2] as { secret: string };
		expect(written.secret).to.match(/^whsec_/u);
		// The one response that carries it.
		expect(created.data.secret).to.equal(written.secret);
	});

	it("uses a supplied secret rather than replacing it", async () => {
		const { service, calls } = serviceWith();

		await service.create(sessionFor(ORGANIZATION_ID), {
			...VALID,
			secret: "whsec_supplied_by_the_integrator",
		});

		expect((calls[0]?.args[2] as { secret: string }).secret).to.equal(
			"whsec_supplied_by_the_integrator",
		);
	});

	it("never returns the secret on a read", async () => {
		const { service } = serviceWith();
		const session = sessionFor(ORGANIZATION_ID);

		const read = await service.get(session, "webhook-1");
		const listed = await service.list(session, { page: 1, limit: 20 } as never);

		// `redactRow` DROPS the key rather than replacing it, so the field is absent and not masked —
		// which is the stronger property: a client cannot mistake a mask for a value.
		expect(read.data).to.not.have.property("secret");
		expect(listed.data[0]).to.not.have.property("secret");
	});

	it("never returns the secret on an update either — a rotation is write-only", async () => {
		const { service } = serviceWith();

		const updated = await service.update(sessionFor(ORGANIZATION_ID), "webhook-1", {
			description: "renamed",
		});

		expect(updated.data).to.not.have.property("secret");
	});

	it("clears the failure state when a subscription is switched back on", async () => {
		const { service, calls } = serviceWith();

		await service.update(sessionFor(ORGANIZATION_ID), "webhook-1", { enabled: true });

		const written = calls[0]?.args[3] as Record<string, unknown>;
		expect(written.consecutiveFailures).to.equal(0);
		expect(written.autoDisabledAt).to.equal(null);
		expect(written.lastFailureReason).to.equal(null);
	});

	it("leaves the failure state alone on an ordinary edit, so a live failure stays visible", async () => {
		const { service, calls } = serviceWith();

		await service.update(sessionFor(ORGANIZATION_ID), "webhook-1", {
			eventSelectors: ["calls.evt.v1.>"],
		});

		const written = calls[0]?.args[3] as Record<string, unknown>;
		expect(written).to.not.have.property("consecutiveFailures");
	});

	it("refuses a plaintext endpoint, and names the field and the escape hatch", async () => {
		const { service } = serviceWith();

		let thrown: unknown;
		try {
			await service.create(sessionFor(ORGANIZATION_ID), {
				...VALID,
				url: "http://example.test/hook",
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).to.be.instanceOf(BadRequestException);
		const body = (thrown as BadRequestException).getResponse() as {
			code: string;
			issues: { field: string }[];
		};
		expect(body.code).to.equal("PBX_INVALID_BODY");
		expect(body.issues[0]?.field).to.equal("url");
	});

	it("allows http when the deployment has opted in", async () => {
		const { service } = serviceWith({ PBX_WEBHOOK_ALLOW_INSECURE_URLS: true } as Partial<PbxEnv>);

		const created = await service.create(sessionFor(ORGANIZATION_ID), {
			...VALID,
			url: "http://localhost:3000/hook",
		});

		expect(created.data.id).to.equal("webhook-1");
	});
});

describe("the webhook DTOs", () => {
	it("accepts a minimal subscription and rejects an unknown key", () => {
		expect(createWebhookDto.safeParse(VALID).success).to.equal(true);
		expect(createWebhookDto.safeParse({ ...VALID, retries: 5 }).success).to.equal(false);
	});

	it("refuses a selector this platform cannot serve, naming it", () => {
		const result = createWebhookDto.safeParse({
			...VALID,
			eventSelectors: ["calls.evt.v1.>", "media.evt.v1.>"],
		});
		expect(result.success).to.equal(false);
		expect(JSON.stringify(result.error?.issues)).to.contain("media.evt.v1.>");
	});

	it("refuses an empty selector list — an endpoint that never fires is a mistake", () => {
		expect(createWebhookDto.safeParse({ ...VALID, eventSelectors: [] }).success).to.equal(false);
	});

	it("refuses a URL with credentials in it, and a relative one", () => {
		expect(
			createWebhookDto.safeParse({ ...VALID, url: "https://user:pass@example.test/hook" }).success,
		).to.equal(false);
		expect(createWebhookDto.safeParse({ ...VALID, url: "/hook" }).success).to.equal(false);
	});

	it("refuses a secret too short to be an HMAC key", () => {
		expect(createWebhookDto.safeParse({ ...VALID, secret: "short" }).success).to.equal(false);
	});

	it("makes every field optional on PATCH, and still validates the ones that are sent", () => {
		expect(updateWebhookDto.safeParse({}).success).to.equal(true);
		expect(updateWebhookDto.safeParse({ enabled: true }).success).to.equal(true);
		expect(updateWebhookDto.safeParse({ eventSelectors: ["nope"] }).success).to.equal(false);
	});
});
