import { CALL_DETAIL_RECORD_MEASUREMENT, INFLUXDB_CALLS_BUCKET } from "@optimiq-voice/common";
import { upsertDefaultUser } from "@optimiq-voice/identity";
import { Context, Effect, Layer, Schema } from "../../node_modules/effect/dist/index.js";
import { identityConfig } from "../core/identityConfig.js";
import runServices from "../core/runServices.js";
import { upsertDefaultPeer } from "../core/upsertDefaultPeer.js";
import {
	INFLUXDB_ORG,
	INFLUXDB_TOKEN,
	INFLUXDB_URL,
	NATS_URL,
	OWNER_EMAIL,
	OWNER_NAME,
	OWNER_PASSWORD,
} from "../envs.js";
import { createInfluxDbPub } from "../events/createInfluxDbPub.js";
import { watchNats } from "../events/nats.js";
import { transformEvent } from "../events/transformEvent.js";

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("RuntimeError", {
	operation: Schema.String,
	message: Schema.String,
}) {}

type RuntimeHandle = {
	readonly close: Effect.Effect<void, RuntimeError>;
};

type Interface = {
	readonly start: () => Effect.Effect<RuntimeHandle, RuntimeError>;
};

export class ApiRuntime extends Context.Service<ApiRuntime, Interface>()(
	"@optimiq-voice/api/ApiRuntime",
) {}

function tryPromise<T>(operation: string, run: () => Promise<T>) {
	return Effect.tryPromise({
		try: run,
		catch: (cause) =>
			new RuntimeError({
				operation,
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	});
}

const start = Effect.fn("ApiRuntime.start")(function* () {
	if (OWNER_EMAIL) {
		yield* tryPromise("identity.upsertDefaultUser", () =>
			upsertDefaultUser(identityConfig, {
				name: OWNER_NAME,
				email: OWNER_EMAIL,
				password: OWNER_PASSWORD,
			}),
		);
	}

	yield* tryPromise("routr.upsertDefaultPeer", upsertDefaultPeer);
	const services = yield* tryPromise("grpc.start", runServices);
	const influx = createInfluxDbPub({
		url: INFLUXDB_URL,
		token: INFLUXDB_TOKEN,
		org: INFLUXDB_ORG,
		bucket: INFLUXDB_CALLS_BUCKET,
	});
	const nats = yield* tryPromise("nats.watch", () =>
		watchNats(NATS_URL, (event: Record<string, unknown>) => {
			void influx.publish({
				name: CALL_DETAIL_RECORD_MEASUREMENT,
				tag: String(event.callId),
				data: transformEvent(event),
			});
		}),
	);

	return {
		close: Effect.gen(function* () {
			yield* tryPromise("nats.close", nats.close);
			yield* tryPromise("influx.close", influx.close);
			yield* tryPromise("grpc.close", services.close);
		}),
	} satisfies RuntimeHandle;
});

export const ApiRuntimeLive = Layer.succeed(ApiRuntime, ApiRuntime.of({ start }));

export const startApiRuntime = Effect.gen(function* () {
	const runtime = yield* ApiRuntime;
	return yield* runtime.start();
});

export async function runApiRuntime() {
	const handle = await Effect.runPromise(startApiRuntime.pipe(Effect.provide(ApiRuntimeLive)));

	return {
		close: () => Effect.runPromise(handle.close),
	};
}
