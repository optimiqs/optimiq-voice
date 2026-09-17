import { Session } from "node:inspector/promises";
import { Controller, ForbiddenException, Get, Inject, Query, Res } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { ENGINE_ENV } from "../nats/nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type { FastifyReply } from "fastify";

const MIN_SECONDS = 1;
const MAX_SECONDS = 120;
const DEFAULT_SECONDS = 20;
/**
 * 1000 µs between samples — V8's own default. Finer sampling costs the very thread being measured,
 * which on a single-threaded process is the thread the measurement is trying not to disturb.
 */
const SAMPLE_INTERVAL_US = 1_000;

/**
 * On-demand V8 CPU profiling, on the PRIVATE health listener and off unless `ENGINE_PROFILING=true`.
 *
 * `apps/sipd` and `apps/mediad` have carried `/debug/pprof` on their health listeners since
 * bring-up; this is the engine's equivalent and exists for the same reason. The alternative,
 * `node --cpu-prof`, requires deciding to profile BEFORE the process starts and only yields its
 * profile once the process has exited — neither of which is available when the thing worth
 * profiling is a live storm on a running instance.
 *
 * The response is a `.cpuprofile`: the JSON the Chrome DevTools profiler and `speedscope` both
 * read directly.
 *
 * ## Why one profile at a time
 *
 * `Profiler.start` on an inspector session is process-wide state, not session-local. Two overlapping
 * requests would have the second's `stop` collect the first's samples and leave the first waiting
 * on a profiler nobody restarted. A second caller is refused rather than queued, because a queued
 * profile would silently cover a different window than the one asked for.
 */
@Controller("/debug")
export class ProfilingController {
	private readonly logger = getLogger("engine.profiling");
	private running = false;

	constructor(@Inject(ENGINE_ENV) private readonly env: EngineEnv) {}

	@Get("/profile")
	async profile(
		@Res({ passthrough: true }) reply: FastifyReply,
		@Query("seconds") seconds?: string,
	): Promise<string> {
		if (!this.env.ENGINE_PROFILING) {
			throw new ForbiddenException("profiling is disabled; set ENGINE_PROFILING=true");
		}
		if (this.running) {
			throw new ForbiddenException("a CPU profile is already being collected");
		}
		const duration = clampSeconds(seconds);
		this.running = true;
		const session = new Session();
		try {
			session.connect();
			await session.post("Profiler.enable");
			await session.post("Profiler.setSamplingInterval", { interval: SAMPLE_INTERVAL_US });
			await session.post("Profiler.start");
			this.logger.info({ seconds: duration }, "CPU profile started");
			await sleep(duration * 1_000);
			const { profile } = await session.post("Profiler.stop");
			await session.post("Profiler.disable");
			void reply.header("content-type", "application/json");
			void reply.header(
				"content-disposition",
				`attachment; filename="engine-${Date.now()}.cpuprofile"`,
			);
			return JSON.stringify(profile);
		} finally {
			// The session holds an inspector channel open; leaving one behind on every failed request
			// would leak a channel per attempt on the process this endpoint exists to keep healthy.
			session.disconnect();
			this.running = false;
		}
	}
}

function clampSeconds(raw: string | undefined): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_SECONDS;
	}
	return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, parsed));
}

async function sleep(ms: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}
