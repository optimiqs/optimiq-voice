import { Stream } from "stream";
import * as grpc from "@grpc/grpc-js";
import {
	GrpcError,
	StreamEvent,
	VoiceClientConfig,
	VoiceIn,
	VoiceSessionStreamClient,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { GRPCClient } from "../types";
import { VoiceServiceClientConstructor } from "../utils/VoiceServiceClientConstructor";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

class GrpcClientHandler {
	private config: VoiceClientConfig;
	private verbsStream: Stream;
	private grpcClient: GRPCClient;
	private voice: VoiceSessionStreamClient;

	constructor(params: { config: VoiceClientConfig; verbsStream: Stream }) {
		this.config = params.config;
		this.verbsStream = params.verbsStream;
	}

	async setupGrpcClient(): Promise<void> {
		this.grpcClient = new VoiceServiceClientConstructor(
			this.config.endpoint,
			grpc.credentials.createInsecure(),
		) as unknown as GRPCClient;

		const metadata = new grpc.Metadata();
		metadata.add("accessKeyId", this.config.accessKeyId);
		metadata.add("token", this.config.sessionToken);

		this.voice = this.grpcClient.createSession(metadata);

		this.setupEventHandlers();

		// Initialize the session
		this.voice.write({ request: this.config });
	}

	private setupEventHandlers(): void {
		this.voice.on(StreamEvent.DATA, (data: VoiceIn) => {
			this.verbsStream.emit(data.content, data);
		});

		this.voice.on(StreamEvent.ERROR, (error: GrpcError) => {
			if (error.code === grpc.status.UNAVAILABLE) {
				logger.error(`voice server not available at "${this.config.endpoint}"`);
				return;
			}
			logger.error(`grpc stream error: ${error.message}`);
		});
	}

	getVoiceStream(): VoiceSessionStreamClient {
		return this.voice;
	}

	sendResponse(response: VoiceIn): void {
		try {
			this.voice.write(response);
		} catch (error) {
			logger.error(`error sending response: ${error.message}`);
		}
	}

	close(): void {
		try {
			this.voice.end();
			this.grpcClient.close();
		} catch (e) {
			// Ignore errors on close
		}
	}
}

export { GrpcClientHandler };
