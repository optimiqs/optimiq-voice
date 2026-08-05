import { Stream } from "stream";
import { VoiceClientConfig } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { AudioSocket, AudioStream } from "@optimiq-voice/streams";
import { transcribeOnConnection } from "../transcribeOnConnection";

const logger = getLogger({ service: "api", filePath: __filename });

class AudioSocketHandler {
	private audioSocket: AudioSocket;
	private audioStream: AudioStream;
	private transcriptionsStream: Stream;
	private config: VoiceClientConfig;

	constructor(params: { transcriptionsStream: Stream; config: VoiceClientConfig }) {
		this.transcriptionsStream = params.transcriptionsStream;
		this.config = params.config;
	}

	async setupAudioSocket(port: number): Promise<void> {
		return new Promise((resolve) => {
			logger.verbose("creating audio socket", { port });
			this.audioSocket = new AudioSocket();

			this.audioSocket.onConnection(async (req, res) => {
				logger.verbose("audio socket connection received", {
					ref: req.ref,
					mediaSessionRef: this.config.mediaSessionRef,
				});

				transcribeOnConnection(this.transcriptionsStream)(req, res);

				res.onClose(() => {
					logger.verbose("session audio stream closed", {
						mediaSessionRef: this.config.mediaSessionRef,
					});
				});

				res.onError((err) => {
					logger.error("session audio stream error", {
						error: err,
						mediaSessionRef: this.config.mediaSessionRef,
					});
				});

				this.audioStream = res;

				resolve();
			});

			this.audioSocket.listen(port, () => {
				logger.verbose("audio socket listening", {
					port,
					appRef: this.config.appRef,
				});
			});
		});
	}

	getAudioStream(): AudioStream {
		return this.audioStream;
	}

	close(): void {
		try {
			this.audioSocket.close();
		} catch (e) {
			// Ignore errors on close
		}
	}
}

export { AudioSocketHandler };
