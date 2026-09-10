import { describe, expect, it } from "bun:test";
import { runQueueSurvey } from "./queue-survey";
import type { QueueSurveyCallPort } from "./queue-survey";
import type { QueueSurveyPlan } from "@optimiq-voice/events";

/**
 * The post-call survey, driven by the five media primitives it is allowed to use.
 *
 * The port is an object literal because that is the whole claim this file makes: a survey needs a
 * leg that can play, a leg that can be asked what was pressed, and a clock — no channel, no bridge,
 * and nothing that could keep a call up.
 */

const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000a1";
const START = Date.parse("2026-08-05T12:00:00.000Z");

function question(position: 1 | 2 | 3): QueueSurveyPlan["questions"][number] {
	return {
		id: `0195c0f0-1c2f-7000-8000-00000000000${String(position)}`,
		position,
		promptId: `0195c0f0-1c2f-7000-8000-0000000000f${String(position)}`,
		label: `question ${String(position)}`,
	};
}

interface SurveyHarness {
	readonly call: QueueSurveyCallPort;
	readonly played: string[];
	readonly notes: string[];
	readonly clock: { now: number };
	hangUp(): void;
}

function port(
	options: {
		readonly digits?: readonly (string | undefined)[];
		/** Polls that return nothing before the scripted digits start, so a question can time out. */
		readonly silentPolls?: number;
		readonly playFailsAt?: number;
		readonly playThrows?: boolean;
	} = {},
): SurveyHarness {
	const played: string[] = [];
	const notes: string[] = [];
	const clock = { now: START };
	const pressed = [...(options.digits ?? [])];
	let silent = options.silentPolls ?? 0;
	const state = { tearingDown: false };

	const call: QueueSurveyCallPort = {
		get isTearingDown(): boolean {
			return state.tearingDown;
		},
		play: async (media: string) => {
			played.push(media);
			if (options.playThrows === true) {
				throw new Error("the media server refused the playback");
			}
			return played.length !== options.playFailsAt;
		},
		pollDigit: () => {
			if (silent > 0) {
				silent -= 1;
				return undefined;
			}
			return pressed.shift();
		},
		resolvePrompt: (promptId) => (promptId === undefined ? undefined : `sound:${promptId}`),
		note: (message) => {
			notes.push(message);
		},
		delay: async (ms: number) => {
			clock.now += ms;
		},
		now: () => clock.now,
	};

	return {
		call,
		played,
		notes,
		clock,
		hangUp: () => {
			state.tearingDown = true;
		},
	};
}

const THREE: QueueSurveyPlan = {
	introPromptId: "0195c0f0-1c2f-7000-8000-0000000000e0",
	questions: [question(1), question(2), question(3)],
};

function run(harness: SurveyHarness, survey: QueueSurveyPlan = THREE) {
	return runQueueSurvey({ survey, call: harness.call, queueId: QUEUE, pollIntervalMs: 500 });
}

describe("the post-call survey", () => {
	it("plays the intro then each question in order and records one digit each", async () => {
		const harness = port({ digits: ["1", "5", "3"] });
		const answers = await run(harness);

		expect(harness.played).toEqual([
			"sound:0195c0f0-1c2f-7000-8000-0000000000e0",
			"sound:0195c0f0-1c2f-7000-8000-0000000000f1",
			"sound:0195c0f0-1c2f-7000-8000-0000000000f2",
			"sound:0195c0f0-1c2f-7000-8000-0000000000f3",
		]);
		expect(answers).toEqual([
			{ questionId: question(1).id, digit: "1" },
			{ questionId: question(2).id, digit: "5" },
			{ questionId: question(3).id, digit: "3" },
		]);
	});

	it("asks the questions in `position` order rather than in array order", async () => {
		const harness = port({ digits: ["1", "2", "3"] });
		const answers = await run(harness, {
			questions: [question(3), question(1), question(2)],
		});
		expect(answers.map((answer) => answer.questionId)).toEqual([
			question(1).id,
			question(2).id,
			question(3).id,
		]);
	});

	it("reports the answers already given when the caller hangs up after the first", async () => {
		const harness = port({ digits: ["4"] });
		// Gone the moment the first answer is in — exactly what an agent-initiated hangup taking the
		// caller's leg with it looks like from in here.
		const inner = harness.call;
		let answered = false;
		const answers = await runQueueSurvey({
			survey: THREE,
			queueId: QUEUE,
			pollIntervalMs: 500,
			call: {
				...inner,
				get isTearingDown(): boolean {
					return answered;
				},
				play: (media: string) => inner.play(media),
				pollDigit: () => {
					const digit = inner.pollDigit();
					answered ||= digit !== undefined;
					return digit;
				},
			},
		});
		expect(answers).toEqual([{ questionId: question(1).id, digit: "4" }]);
		expect(harness.notes.join(" ")).toContain("hung up");
	});

	it("leaves an unanswered question out entirely rather than recording a zero", async () => {
		const harness = port({ digits: ["2", "2"], silentPolls: 3 });
		const answers = await runQueueSurvey({
			survey: THREE,
			call: harness.call,
			queueId: QUEUE,
			pollIntervalMs: 500,
			answerTimeoutMs: 1_000,
		});
		// Question one times out and is simply absent; the survey carries on to two and three.
		expect(answers).toEqual([
			{ questionId: question(2).id, digit: "2" },
			{ questionId: question(3).id, digit: "2" },
		]);
	});

	it("ignores a digit outside 1-5 and treats the question as unanswered", async () => {
		const harness = port({ digits: ["9"] });
		const answers = await runQueueSurvey({
			survey: { questions: [question(1)] },
			call: harness.call,
			queueId: QUEUE,
			pollIntervalMs: 500,
		});
		expect(answers).toEqual([]);
	});

	it("stops without throwing when a prompt cannot be played", async () => {
		const harness = port({ digits: ["1", "2", "3"], playFailsAt: 3 });
		const answers = await run(harness);
		// Intro, question one and the refused question two. Nothing after it.
		expect(harness.played).toHaveLength(3);
		expect(answers).toEqual([{ questionId: question(1).id, digit: "1" }]);
		expect(harness.notes.join(" ")).toContain("could not be played");
	});

	it("stops without throwing when the play throws outright", async () => {
		const harness = port({ playThrows: true });
		const answers = await run(harness);
		expect(answers).toEqual([]);
		expect(harness.notes.join(" ")).toContain("prompt failed");
	});

	it("asks a survey with no intro prompt straight away", async () => {
		const harness = port({ digits: ["5"] });
		const answers = await runQueueSurvey({
			survey: { questions: [question(1)] },
			call: harness.call,
			queueId: QUEUE,
			pollIntervalMs: 500,
		});
		expect(harness.played).toEqual(["sound:0195c0f0-1c2f-7000-8000-0000000000f1"]);
		expect(answers).toEqual([{ questionId: question(1).id, digit: "5" }]);
	});

	it("gives up on a question after its timeout rather than holding the leg", async () => {
		const harness = port();
		await runQueueSurvey({
			survey: { questions: [question(1)] },
			call: harness.call,
			queueId: QUEUE,
			pollIntervalMs: 500,
			answerTimeoutMs: 2_000,
		});
		expect(harness.clock.now).toBe(START + 2_000);
	});
});
