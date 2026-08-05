import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox, match } from "sinon";
import sinonChai from "sinon-chai";
import { StreamEvent } from "@optimiq-voice/common";
import { VoiceRequest } from "../src/types";
import { VoiceResponse } from "../src/VoiceResponse";
import { mediaSessionRef, voiceRequest } from "./helpers";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@voice/createSession", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should create a session", async function () {
		const callbackResponses = [
			{ answerResponse: { mediaSessionRef }, content: "answerResponse" },
			{
				playResponse: { mediaSessionRef, playbackRef: "123" },
				content: "playResponse",
			},
			{ hangupResponse: { mediaSessionRef }, content: "hangupResponse" },
		];
		let cnt = 0;

		// Arrange
		const onceStub = sandbox.stub().callsFake((event: StreamEvent, cb: (params) => void) => {
			if (event === StreamEvent.DATA) {
				cb({ request: voiceRequest });
			}
			// We purposely ignore the END event to avoid the process to exit
		});

		const onStub = sandbox.stub().callsFake((event: StreamEvent, cb: (params) => void) => {
			cb(callbackResponses[cnt++]);
		});

		const voice = {
			removeListener: sandbox.stub(),
			on: onStub,
			once: onceStub,
			write: sandbox.stub(),
			end: sandbox.stub(),
		};

		const { createSession } = await import("../src/createSession");

		const handler = async (req: VoiceRequest, res: VoiceResponse) => {
			await res.answer();
			await res.play("http://example.com/audio.mp3");
			await res.hangup();
		};

		// Act
		await createSession(handler)(voice);

		// Assert
		expect(voice.once).to.have.been.calledWith(StreamEvent.DATA, match.func);
		expect(voice.once).to.have.been.calledWith(StreamEvent.END, match.func);
		expect(voice.once).to.have.been.calledTwice;
		expect(voice.on).to.have.been.calledThrice;
		expect(voice.write).to.have.been.calledThrice;
		expect(voice.write).to.have.been.calledWith({
			answerRequest: { mediaSessionRef },
		});
		expect(voice.write).to.have.been.calledWith({
			playRequest: { mediaSessionRef, url: "http://example.com/audio.mp3" },
		});
		expect(voice.write).to.have.been.calledWith({
			hangupRequest: { mediaSessionRef },
		});
	});
});
