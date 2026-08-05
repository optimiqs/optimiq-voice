import { Client } from "ari-client";
import { SinonSandbox } from "sinon";

function getAriStub(sandbox: SinonSandbox) {
	return {
		Channel: sandbox.stub().returns({
			originate: sandbox.stub(),
			on: sandbox.stub(),
			once: sandbox.stub(),
			hangup: sandbox.stub(),
			getChannelVar: sandbox.stub().resolves({ value: "value" }),
		}),
		on: sandbox.stub(),
		once: sandbox.stub(),
		start: sandbox.stub(),
		removeListener: sandbox.stub(),
		channels: {
			get: sandbox.stub().resolves({
				getChannelVar: sandbox.stub().resolves({ value: "value" }),
			}),
			ring: sandbox.stub(),
			ringStop: sandbox.stub(),
			record: sandbox.stub(),
			answer: sandbox.stub(),
			play: sandbox.stub(),
			hangup: sandbox.stub(),
			mute: sandbox.stub(),
			unmute: sandbox.stub(),
			sendDTMF: sandbox.stub(),
			snoopChannel: sandbox.stub(),
		},
		playbacks: {
			control: sandbox.stub(),
			stop: sandbox.stub(),
		},
		bridges: {
			get: sandbox.stub(),
			create: sandbox.stub().resolves({
				addChannel: sandbox.stub(),
				destroy: sandbox.stub(),
			}),
		},
	} as unknown as Client;
}

function getCreateVoiceClient(sandbox: SinonSandbox) {
	return sandbox.stub().returns({
		config: {
			sessionId: "channelId",
		},
		close: sandbox.stub(),
		sendResponse: sandbox.stub(),
		startSpeechGather: sandbox.stub(),
		startDtmfGather: sandbox.stub(),
	});
}

/**
 * Previously imported from `@optimiq-voice/voice/test/helpers`, which apps/api does not depend
 * on — the specifier only ever resolved by accident and broke the suite outright once the
 * package layout changed. It is a fixture constant, so it lives with the other apps/api fixtures.
 */
const mediaSessionRef = "848b8803-7106-48b7-b820-515b05c40d6b";

export { getAriStub, getCreateVoiceClient, mediaSessionRef };
