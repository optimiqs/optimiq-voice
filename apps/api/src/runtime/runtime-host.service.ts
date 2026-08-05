import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
type RuntimeHandle = {
	close(): Promise<void>;
};

@Injectable()
export class RuntimeHostService implements OnApplicationBootstrap, OnApplicationShutdown {
	private handle: RuntimeHandle | undefined;

	async onApplicationBootstrap() {
		const { runApiRuntime } = await import("./app-runtime");
		this.handle = await runApiRuntime();
	}

	async onApplicationShutdown() {
		if (!this.handle) {
			return;
		}

		await this.handle.close();
	}
}
