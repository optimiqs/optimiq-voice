import type { QueueSurveyPlan } from "@optimiq-voice/events";

/**
 * The post-call survey: the questions a caller is asked once the agent has gone.
 *
 * ## Why it is a separate file and a pure function
 *
 * Everything here happens after the call is over. The caller is on a leg with nothing on the other
 * end of it, the agent is in wrap-up, and the routing decision that brought them here was made
 * minutes ago — so none of `queue-session.ts`'s state is relevant and none of this belongs in its
 * loop. What is left is a script: play a prompt, wait for one key, write it down, move on. Given the
 * five media primitives it needs, that is a function with no session in it, which is why the spec
 * beside this file drives a whole survey with an object literal.
 *
 * ## It uses `play` and `pollDigit` and nothing else
 *
 * There is no `gather` on {@link import("./queue-session").QueueCallPort} and this deliberately does
 * not add one. The port's `pollDigit` observes the leg's DTMF without consuming it from anyone else
 * (see its own comment), and a survey is exactly the case that poll shape suits: one digit, a short
 * patience, and no consequence for missing it. Adding media plumbing for a questionnaire would put a
 * second collection mechanism on a leg that already has one.
 *
 * ## Nothing here may keep a leg alive, and nothing here may throw
 *
 * A survey is worth less than the call it is about — and it runs from the ARI event socket's
 * `onEnded` callback, where an exception takes every other live call with it. So every exit is a
 * return: a caller who has hung up, a prompt that will not resolve, a media server that refuses a
 * playback all end the survey where it stands and keep the answers already given. The one thing
 * that is never done is turning a completed call into an error.
 *
 * ## An unanswered question has no answer
 *
 * Not a zero, not a sentinel. `packages/pbx-db` says so on the answer row and it is the only honest
 * shape: "the caller did not press anything" and "the caller pressed the lowest score" are opposite
 * facts, and a report that averaged them together would show a queue getting worse every time
 * somebody hung up early.
 */

/** The keypad a survey question accepts. Anything else is ignored, exactly as silence is. */
export const QUEUE_SURVEY_DIGITS: readonly string[] = ["1", "2", "3", "4", "5"];

/** How long one question waits for its digit before moving on. */
export const QUEUE_SURVEY_ANSWER_TIMEOUT_MS = 5_000;

export interface QueueSurveyAnswer {
	readonly questionId: string;
	readonly digit: string;
}

/**
 * The slice of {@link import("./queue-session").QueueCallPort} a survey needs.
 *
 * Narrowed on purpose: the port a survey is handed cannot originate, bridge or hang anything up,
 * so the question "could this keep a leg up?" is answered by the type rather than by review.
 */
export interface QueueSurveyCallPort {
	readonly isTearingDown: boolean;
	play(media: string): Promise<boolean>;
	pollDigit(): string | undefined;
	resolvePrompt(promptId: string | undefined): string | undefined;
	note(message: string): void;
	delay(ms: number): Promise<void>;
	now(): number;
}

export interface QueueSurveyInput {
	readonly survey: QueueSurveyPlan;
	readonly call: QueueSurveyCallPort;
	readonly queueId: string;
	/** How long each question waits. Defaults to {@link QUEUE_SURVEY_ANSWER_TIMEOUT_MS}. */
	readonly answerTimeoutMs?: number;
	/** How often the leg's digit buffer is looked at while waiting. */
	readonly pollIntervalMs: number;
}

/**
 * Asks the caller the queue's questions and returns what they pressed.
 *
 * Returns the answers given SO FAR whenever it stops early, which is the difference between a
 * survey and a transaction: two questions answered out of three is two more data points than the
 * queue had, and discarding them because the third went unanswered would throw away the common case.
 */
export async function runQueueSurvey(
	input: QueueSurveyInput,
): Promise<readonly QueueSurveyAnswer[]> {
	const { call } = input;
	const answers: QueueSurveyAnswer[] = [];

	const intro = call.resolvePrompt(input.survey.introPromptId);
	if (intro !== undefined && !(await playOrStop(input, intro, "intro"))) {
		return answers;
	}

	const questions = [...input.survey.questions].sort(
		(left, right) => left.position - right.position,
	);
	for (const question of questions) {
		if (call.isTearingDown) {
			call.note(
				`queue "${input.queueId}": the caller hung up before question ${String(question.position)} of the survey`,
			);
			return answers;
		}
		const media = call.resolvePrompt(question.promptId);
		if (
			media !== undefined &&
			!(await playOrStop(input, media, `question ${String(question.position)}`))
		) {
			return answers;
		}
		const digit = await awaitAnswer(input);
		if (digit !== undefined) {
			answers.push({ questionId: question.id, digit });
		}
	}

	return answers;
}

/** Plays one prompt, noting and stopping the survey when the leg or the media server refuses it. */
async function playOrStop(input: QueueSurveyInput, media: string, what: string): Promise<boolean> {
	try {
		if (await input.call.play(media)) {
			return true;
		}
	} catch (error) {
		input.call.note(
			`queue "${input.queueId}": the survey ${what} prompt failed (${String(error)}); the survey stopped there`,
		);
		return false;
	}
	input.call.note(
		`queue "${input.queueId}": the survey ${what} prompt could not be played; the survey stopped there`,
	);
	return false;
}

/** One digit, or nothing, inside this question's patience. */
async function awaitAnswer(input: QueueSurveyInput): Promise<string | undefined> {
	const { call } = input;
	const until = call.now() + (input.answerTimeoutMs ?? QUEUE_SURVEY_ANSWER_TIMEOUT_MS);
	for (;;) {
		if (call.isTearingDown) {
			return undefined;
		}
		const digit = call.pollDigit();
		if (digit !== undefined && QUEUE_SURVEY_DIGITS.includes(digit)) {
			return digit;
		}
		if (call.now() >= until) {
			return undefined;
		}
		await call.delay(Math.min(input.pollIntervalMs, Math.max(1, until - call.now())));
	}
}
