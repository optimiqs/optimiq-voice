import * as grpcWeb from "grpc-web";
import { AbstractClient } from "./AbstractClient";
import { isJwtExpired } from "./isJwtExpired";

type ClientReadableStream = grpcWeb.ClientReadableStream<unknown>;

class TokenRefresherWeb {
	private client: AbstractClient;

	constructor(client: AbstractClient) {
		this.client = client;
	}

	intercept(request: unknown, invoker: (request: unknown) => ClientReadableStream) {
		class InterceptedStream {
			refresher: TokenRefresherWeb;
			stream: ClientReadableStream;

			constructor(stream: ClientReadableStream, refresher: TokenRefresherWeb) {
				this.stream = stream;
				this.refresher = refresher;
			}

			on(eventType: string, callback: () => void) {
				const token = this.refresher.client.getAccessToken();

				if (isJwtExpired(token)) {
					this.refresher.client.refreshToken().then(() => {});
				}

				if (eventType == "data") {
					this.stream.on(eventType, callback);
				} else if (eventType == "error") {
					this.stream.on("error", callback);
				} else if (eventType == "metadata") {
					this.stream.on("metadata", callback);
				} else if (eventType == "status") {
					this.stream.on("status", callback);
				} else if (eventType == "end") {
					this.stream.on("end", callback);
				}

				return this;
			}
		}

		return new InterceptedStream(invoker(request), this);
	}
}

export { TokenRefresherWeb };
