/**
 * A throwaway JetStream broker for the load harness in this directory.
 *
 * Docker-free on purpose: the machine this was written on has no daemon, and a benchmark that
 * cannot be run is not a benchmark. Point `NATS_SERVER_BIN` at a JetStream-capable `nats-server`
 * (the same variable `apps/sipd`'s integration tests read) or put one on `PATH`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "nats";

export interface Broker {
	readonly url: string;
	stop(): void;
}

function freePort(): number {
	// 4300–4699: above the default 4222 so a locally running broker is never disturbed.
	return 4300 + Math.floor(Math.random() * 400);
}

/**
 * `extraConfig` is appended verbatim to a generated config file instead of using the flag form.
 *
 * The one caller that needs it is `routing-watch-stall.spec.ts`, which has to reproduce a broker
 * REFUSING a publish — an authorization block is the only way to make a real server do that, and
 * a real server doing it is the whole point of that spec.
 */
export async function startBroker(
	options: { extraConfig?: string; probe?: { user: string; pass: string } } = {},
): Promise<Broker> {
	const bin = process.env.NATS_SERVER_BIN ?? "nats-server";
	const store = mkdtempSync(join(tmpdir(), "optimiq-bench-js-"));
	const port = freePort();
	const conf = join(store, "nats.conf");
	writeFileSync(
		conf,
		`port: ${String(port)}\nhost: "127.0.0.1"\njetstream: { store_dir: "${store}/js" }\n${options.extraConfig ?? ""}\n`,
	);
	const child: ChildProcess = spawn(bin, ["-c", conf], {
		stdio: "ignore",
	});
	const url = `nats://127.0.0.1:${String(port)}`;
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			const probe = await connect({
				servers: url,
				maxReconnectAttempts: 1,
				timeout: 500,
				...options.probe,
			});
			await probe.close();
			break;
		} catch (error) {
			if (Date.now() > deadline) {
				child.kill("SIGKILL");
				throw new Error(`nats-server did not start on ${url}: ${String(error)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	return {
		url,
		stop(): void {
			child.kill("SIGKILL");
			rmSync(store, { recursive: true, force: true });
		},
	};
}

export async function connectTo(broker: Broker, name: string): Promise<NatsConnection> {
	return await connect({ servers: broker.url, name, maxReconnectAttempts: -1 });
}

/** p50/p99 over a sample of millisecond latencies. */
export function percentiles(samples: number[]): { p50: number; p99: number; max: number } {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (q: number): number =>
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
	return { p50: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0 };
}

/** Mean event-loop lag over `ms`, sampled every 10ms. Cheap and good enough to see blocking. */
export function lagSampler(): { stop(): { mean: number; max: number } } {
	const samples: number[] = [];
	let last = process.hrtime.bigint();
	const timer = setInterval(() => {
		const now = process.hrtime.bigint();
		samples.push(Number(now - last) / 1e6 - 10);
		last = now;
	}, 10);
	return {
		stop(): { mean: number; max: number } {
			clearInterval(timer);
			const positive = samples.map((value) => Math.max(0, value));
			const mean = positive.reduce((sum, value) => sum + value, 0) / Math.max(1, positive.length);
			return { mean, max: Math.max(0, ...positive) };
		},
	};
}
