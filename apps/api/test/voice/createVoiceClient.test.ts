import { Channel, Client, StasisStart } from "ari-client";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";
import { CreateContainer } from "../../src/voice/integrations/types";
import { AbstractTextToSpeech } from "../../src/voice/tts/AbstractTextToSpeech";
import { ChannelVar } from "../../src/voice/types";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

const channelId = "channel-id";

/**
 * A stand-in for the auth slice `AuthModule` publishes at boot.
 *
 * `createCreateVoiceClient` mints the per-call token through better-auth since identity-removal
 * Step 4 item 4, and reaches the platform through `auth-platform.registry.ts` because the ARI
 * dispatcher is started outside the Nest container. Only `auth.api.signJWT` is exercised here:
 * since Step 5 item 1 the application row carries `organization_id`, so `createContainer` yields
 * the tenant directly and the ledger lookup this factory used to make on every call is gone.
 */
function fakeAuthRuntime() {
	const signed: Record<string, unknown>[] = [];
	return {
		signed,
		handle: {
			platform: {
				auth: {
					api: {
						signJWT: async (input: { body: { payload: Record<string, unknown> } }) => {
							signed.push(input.body.payload);
							return { token: "signed.call.token" };
						},
					},
				},
			},
		},
	};
}

describe("@voice/createVoiceClient", function () {
	afterEach(async function () {
		const { clearAuthRuntime } = await import("../../src/auth/auth-platform.registry");
		clearAuthRuntime();
		return sandbox.restore();
	});

	it("should create a voice client", async function () {
		// Arrange
		// Both the factory and the class it returns are pulled in through the same dynamic import
		// graph on purpose. Under `mocha --import tsx` a module reached by a hoisted static import
		// and the same module reached by `await import(...)` are evaluated into two separate
		// registries, so a statically imported `VoiceClientImpl` would never be the constructor the
		// factory actually used and `instanceOf` would fail.
		const { createCreateVoiceClient } = await import("../../src/voice/createCreateVoiceClient");
		const { VoiceClientImpl } = await import("../../src/voice/client/VoiceClientImpl");
		const { publishAuthRuntime } = await import("../../src/auth/auth-platform.registry");

		const organizationId = "019fd3c2-0203-76be-a6b3-b0f1914e39b6";
		const runtime = fakeAuthRuntime();
		publishAuthRuntime(runtime.handle as never);

		const createContainer = async (appRef: string) => {
			return {
				ref: appRef,
				organizationId,
				endpoint: "app-endpoint",
				tts: {} as unknown as AbstractTextToSpeech<unknown>,
				stt: {} as unknown as AbstractTextToSpeech<unknown>,
			};
		};

		const event = {
			channel: {
				id: channelId,
				caller: {
					name: "John Doe",
					number: "+17853178070",
				},
			},
		} as unknown as StasisStart;

		const channel = {
			id: channelId,
			originate: sandbox.stub(),
			hangup: sandbox.stub(),
			on: sandbox.stub(),
			getChannelVar: sandbox
				.stub()
				.onFirstCall()
				.resolves({ value: "from-pstn" })
				.onSecondCall()
				.resolves({ value: "app-ref" })
				.onThirdCall()
				.resolves({ value: "ingress-number" })
				.onCall(3)
				.resolves({ value: "call-ref-from-api" })
				.onCall(4)
				.resolves({ value: "{}" }),
		} as unknown as Channel;

		// Act
		const voiceClient = await createCreateVoiceClient(
			createContainer as unknown as CreateContainer,
		)({
			ari: {} as Client,
			event,
			channel,
		});

		// Assert
		expect(voiceClient).to.be.an.instanceOf(VoiceClientImpl);
		// Step 4 item 4: the token comes from better-auth and carries the ORGANIZATION as the tenant
		// claim. Since Step 5 item 1 the container supplies it straight from
		// `applications.organization_id`, with no ledger translation in between.
		expect(runtime.signed).to.have.lengthOf(1);
		expect(runtime.signed[0]).to.include({
			organizationId,
			accessKeyId: organizationId,
			appRef: "app-ref",
			callRef: "call-ref-from-api",
			tokenUse: "access",
		});
		expect(channel.getChannelVar).to.have.callCount(5);
		expect(channel.getChannelVar).to.have.been.calledWith({
			variable: ChannelVar.APP_REF,
		});
		expect(channel.getChannelVar).to.have.been.calledWith({
			variable: ChannelVar.METADATA,
		});
		expect(channel.getChannelVar).to.have.been.calledWith({
			variable: ChannelVar.INGRESS_NUMBER,
		});
		expect(channel.getChannelVar).to.have.been.calledWith({
			variable: ChannelVar.CALL_DIRECTION,
		});
		expect(channel.getChannelVar).to.have.been.calledWith({
			variable: ChannelVar.CALL_REF,
		});
	});

	it("refuses to place a call when the container yields no tenant", async function () {
		// Fail closed. `applications.organization_id` is NOT NULL as of Step 5 item 1, so this is
		// unreachable through the real `createContainer` — which is the point: if it ever becomes
		// reachable, no token is minted and no call is placed.
		const { createCreateVoiceClient } = await import("../../src/voice/createCreateVoiceClient");
		const { publishAuthRuntime } = await import("../../src/auth/auth-platform.registry");
		const { CallAccessTokenScopeError } = await import("../../src/auth/call-token.claims");

		publishAuthRuntime(fakeAuthRuntime().handle as never);

		const createContainer = async (appRef: string) => ({
			ref: appRef,
			organizationId: "",
			endpoint: "app-endpoint",
			tts: {} as unknown as AbstractTextToSpeech<unknown>,
			stt: {} as unknown as AbstractTextToSpeech<unknown>,
		});

		const channel = {
			id: channelId,
			getChannelVar: sandbox.stub().resolves({ value: "x" }),
		} as unknown as Channel;

		await expect(
			createCreateVoiceClient(createContainer as unknown as CreateContainer)({
				ari: {} as Client,
				event: {
					channel: { id: channelId, caller: { name: "n", number: "+10000000000" } },
				} as unknown as StasisStart,
				channel,
			}),
		).to.be.rejectedWith(CallAccessTokenScopeError);
	});

	it("refuses to place a call when the auth slice is not mounted", async function () {
		const { createCreateVoiceClient } = await import("../../src/voice/createCreateVoiceClient");
		const { AuthRuntimeUnavailableError, clearAuthRuntime } =
			await import("../../src/auth/auth-platform.registry");
		clearAuthRuntime();

		const createContainer = async (appRef: string) => ({
			ref: appRef,
			organizationId: "019fd41e-e73c-73fc-8fa9-b5512fecd859",
			endpoint: "app-endpoint",
			tts: {} as unknown as AbstractTextToSpeech<unknown>,
			stt: {} as unknown as AbstractTextToSpeech<unknown>,
		});

		await expect(
			createCreateVoiceClient(createContainer as unknown as CreateContainer)({
				ari: {} as Client,
				event: {
					channel: { id: channelId, caller: { name: "n", number: "+10000000000" } },
				} as unknown as StasisStart,
				channel: {
					id: channelId,
					getChannelVar: sandbox.stub().resolves({ value: "x" }),
				} as unknown as Channel,
			}),
		).to.be.rejectedWith(AuthRuntimeUnavailableError);
	});
});
