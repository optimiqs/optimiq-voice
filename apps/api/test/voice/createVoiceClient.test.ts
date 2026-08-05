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
 * dispatcher is started outside the Nest container. Only two things are exercised here: the
 * `accessKeyId → organization.id` lookup and `auth.api.signJWT`.
 */
function fakeAuthRuntime(organizationId: string | null) {
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
			legacyAccessKeys: {
				findOrganizationId: async () => organizationId,
				findAccessKeyId: async () => null,
				invalidate: () => {},
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
		const runtime = fakeAuthRuntime(organizationId);
		publishAuthRuntime(runtime.handle as never);

		const createContainer = async (appRef: string) => {
			return {
				ref: appRef,
				accessKeyId: "access-key-id",
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
		// Step 4 item 4: the token comes from better-auth, and it carries the ORGANIZATION as the
		// tenant claim rather than the legacy `WO…` access key the container still returns.
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

	it("refuses to place a call when the access key was never migrated", async function () {
		// Fail closed: with no `accessKeyId → organization.id` mapping there is no tenant claim to
		// put on the token, and there is no identity signer left to fall back to.
		const { createCreateVoiceClient } = await import("../../src/voice/createCreateVoiceClient");
		const { publishAuthRuntime } = await import("../../src/auth/auth-platform.registry");
		const { UnmappedAccessKeyError } = await import("../../src/auth/legacy-access-key.repository");

		publishAuthRuntime(fakeAuthRuntime(null).handle as never);

		const createContainer = async (appRef: string) => ({
			ref: appRef,
			accessKeyId: "WOnever-migrated",
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
		).to.be.rejectedWith(UnmappedAccessKeyError);
	});

	it("refuses to place a call when the auth slice is not mounted", async function () {
		const { createCreateVoiceClient } = await import("../../src/voice/createCreateVoiceClient");
		const { AuthRuntimeUnavailableError, clearAuthRuntime } =
			await import("../../src/auth/auth-platform.registry");
		clearAuthRuntime();

		const createContainer = async (appRef: string) => ({
			ref: appRef,
			accessKeyId: "WOsomething",
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
