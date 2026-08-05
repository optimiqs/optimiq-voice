import { InterceptingCall, Interceptor, InterceptorOptions, NextCall } from "@grpc/grpc-js";
import { AbstractClient } from "./AbstractClient";
import { isJwtExpired } from "./isJwtExpired";

class TokenRefresherNode {
	private client: AbstractClient;

	constructor(client: AbstractClient) {
		this.client = client;
	}

	createInterceptor(): Interceptor {
		return (options: InterceptorOptions, nextCall: NextCall): InterceptingCall => {
			return new InterceptingCall(nextCall(options), {
				sendMessage: async (message, next) => {
					const token = this.client.getAccessToken();

					if (isJwtExpired(token)) {
						await this.client.refreshToken();
					}

					next(message);
				},
			});
		};
	}
}

export { TokenRefresherNode };
