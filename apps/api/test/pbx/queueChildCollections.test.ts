import { expect } from "chai";
import { QUEUE_DISPOSITION_UNSET } from "@optimiq-voice/pbx-db";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import { QueueAgentsController, QueuesController } from "../../src/pbx/queues/queues.controller";
import {
	createQueueAgentSkillDto,
	createQueueDispositionCodeDto,
	createQueueSkillRequirementDto,
	createQueueSurveyQuestionDto,
	createQueueDto,
	updateQueueDto,
} from "../../src/pbx/queues/queues.dto";
import {
	QUEUE_AGENT_SKILL_RESOURCE,
	QUEUE_DISPOSITION_CODE_RESOURCE,
	QUEUE_SKILL_REQUIREMENT_RESOURCE,
	QUEUE_SURVEY_QUESTION_RESOURCE,
} from "../../src/pbx/queues/queues.resource";

/**
 * The four child collections a queue grew: their DTOs, their permissions and where they hang.
 *
 * The CRUD itself is `PbxChildResourceService`'s and is tested once, in `pbxResourceService.test.ts`
 * — declaring a resource is the whole implementation, so what is worth pinning here is the
 * DECLARATIONS: the permission each surface is behind (the split between "who configures the queue"
 * and "who staffs the floor" is a real distinction that a copy-paste would quietly erase), the
 * parent each collection hangs off, and the two normalisations that keep a vocabulary from
 * fragmenting.
 */

function permissionsOf(handler: unknown): readonly string[] | undefined {
	return Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA, handler as object) as
		| readonly string[]
		| undefined;
}

describe("the queue's new child collections", () => {
	it("hangs the codes, requirements and questions off the queue", () => {
		expect(QUEUE_DISPOSITION_CODE_RESOURCE.parentKind).to.equal("queue");
		expect(QUEUE_SKILL_REQUIREMENT_RESOURCE.parentKind).to.equal("queue");
		expect(QUEUE_SURVEY_QUESTION_RESOURCE.parentKind).to.equal("queue");
	});

	/**
	 * The one whose parent is not the queue, and the reason `queue_agent` is top-level to begin
	 * with: a skill is a property of the PERSON, carried into every queue they staff. Mounting it
	 * under a queue would make one fact look like N.
	 */
	it("hangs an agent's skills off the agent", () => {
		expect(QUEUE_AGENT_SKILL_RESOURCE.parentKind).to.equal("queue-agent");
	});

	/** Nothing may point at any of them as a routing destination. */
	it("declares no destination type on any of them", () => {
		for (const resource of [
			QUEUE_DISPOSITION_CODE_RESOURCE,
			QUEUE_SKILL_REQUIREMENT_RESOURCE,
			QUEUE_SURVEY_QUESTION_RESOURCE,
			QUEUE_AGENT_SKILL_RESOURCE,
		]) {
			expect(resource.destinationType).to.equal(null);
			expect(resource.destinations).to.deep.equal([]);
		}
	});

	/**
	 * A retired code stays for the history that references it. That is only expressible because the
	 * resource declares an `enabled` column — without it there is no way to stop offering a code
	 * short of deleting the row every past disposition points at.
	 */
	it("lets a disposition code be retired rather than only deleted", () => {
		expect(QUEUE_DISPOSITION_CODE_RESOURCE.enabledColumn).to.not.equal(undefined);
	});

	/**
	 * A survey question's `position` IS its identity in every report, so there is deliberately no
	 * `PUT …/reorder`: renumbering rows would silently re-file last month's answers.
	 */
	it("gives none of them a reorder endpoint", () => {
		expect(QUEUE_SURVEY_QUESTION_RESOURCE.ordinalColumn).to.equal(undefined);
		expect(QUEUE_DISPOSITION_CODE_RESOURCE.ordinalColumn).to.equal(undefined);
	});
});

describe("the child collections' permissions", () => {
	it("puts the queue's own vocabulary behind queues.write, and reading behind queues.read", () => {
		expect(permissionsOf(QueuesController.prototype.createDispositionCode)).to.deep.equal([
			"queues.write",
		]);
		expect(permissionsOf(QueuesController.prototype.removeDispositionCode)).to.deep.equal([
			"queues.write",
		]);
		expect(permissionsOf(QueuesController.prototype.listDispositionCodes)).to.deep.equal([
			"queues.read",
		]);
		expect(permissionsOf(QueuesController.prototype.createSkillRequirement)).to.deep.equal([
			"queues.write",
		]);
		expect(permissionsOf(QueuesController.prototype.createSurveyQuestion)).to.deep.equal([
			"queues.write",
		]);
		expect(permissionsOf(QueuesController.prototype.listSurveyQuestions)).to.deep.equal([
			"queues.read",
		]);
	});

	/**
	 * An agent's skills are a STAFFING fact — what a person can do, which decides who is offered
	 * which caller once a queue carries a requirement — so they follow the tiers onto
	 * `queues.manage-agents` rather than the queue's own `queues.write`. Collapsing the two would
	 * make "may staff the floor" imply "may re-point the overflow at an external number", which is
	 * the split `QueuesController`'s header exists to explain.
	 */
	it("puts an agent's skills behind queues.manage-agents", () => {
		expect(permissionsOf(QueueAgentsController.prototype.createSkill)).to.deep.equal([
			"queues.manage-agents",
		]);
		expect(permissionsOf(QueueAgentsController.prototype.updateSkill)).to.deep.equal([
			"queues.manage-agents",
		]);
		expect(permissionsOf(QueueAgentsController.prototype.removeSkill)).to.deep.equal([
			"queues.manage-agents",
		]);
		expect(permissionsOf(QueueAgentsController.prototype.listSkills)).to.deep.equal([
			"queues.read",
		]);
	});
});

describe("the child collections' DTOs", () => {
	it("lower-cases a code and a skill tag so one value is not two", () => {
		expect(createQueueDispositionCodeDto.parse({ code: " SALE ", label: "Sale" }).code).to.equal(
			"sale",
		);
		expect(createQueueAgentSkillDto.parse({ skill: " Spanish " }).skill).to.equal("spanish");
		expect(createQueueSkillRequirementDto.parse({ skill: "SPANISH" }).skill).to.equal("spanish");
	});

	/**
	 * `unset` is what the wrap-up deadline records when nobody chose. A tenant-defined code spelled
	 * the same way would make "nobody answered the question" and "the agent picked the code called
	 * unset" one row in every report. The database refuses it too; this is the copy that lands on a
	 * form field rather than as a constraint name.
	 */
	it("refuses a disposition code named unset", () => {
		expect(
			createQueueDispositionCodeDto.safeParse({ code: QUEUE_DISPOSITION_UNSET, label: "Unset" })
				.success,
		).to.equal(false);
	});

	it("refuses a tag with a space or a leading dash", () => {
		expect(createQueueAgentSkillDto.safeParse({ skill: "spanish fluent" }).success).to.equal(false);
		expect(createQueueAgentSkillDto.safeParse({ skill: "-spanish" }).success).to.equal(false);
	});

	it("bounds a skill level to the 1-5 scale the platform uses everywhere", () => {
		expect(createQueueAgentSkillDto.safeParse({ skill: "spanish", level: 5 }).success).to.equal(
			true,
		);
		expect(createQueueAgentSkillDto.safeParse({ skill: "spanish", level: 6 }).success).to.equal(
			false,
		);
		expect(createQueueAgentSkillDto.safeParse({ skill: "spanish", level: 0 }).success).to.equal(
			false,
		);
	});

	/** `0` is a legitimate value and means the requirement never relaxes — see `pbx-db`. */
	it("accepts a requirement that never relaxes", () => {
		expect(
			createQueueSkillRequirementDto.parse({ skill: "spanish", relaxAfterSeconds: 0 })
				.relaxAfterSeconds,
		).to.equal(0);
	});

	/**
	 * `position` is required and not resettable, unlike every other ordinal on this surface: three
	 * keypresses is the attention a caller has, and the number is the question's identity.
	 */
	it("demands a survey position inside 1-3", () => {
		expect(createQueueSurveyQuestionDto.safeParse({ label: "Resolved?" }).success).to.equal(false);
		expect(
			createQueueSurveyQuestionDto.safeParse({ position: 3, label: "Resolved?" }).success,
		).to.equal(true);
		expect(
			createQueueSurveyQuestionDto.safeParse({ position: 4, label: "Resolved?" }).success,
		).to.equal(false);
	});
});

describe("the queue's new columns", () => {
	it("accepts the four new flags and lets the intro prompt be cleared", () => {
		const parsed = createQueueDto.parse({
			name: "Sales",
			dispositionRequired: true,
			ronaEnabled: true,
			surveyEnabled: true,
			surveyIntroPromptId: null,
		});
		expect(parsed.dispositionRequired).to.equal(true);
		expect(parsed.ronaEnabled).to.equal(true);
		expect(parsed.surveyEnabled).to.equal(true);
		expect(parsed.surveyIntroPromptId).to.equal(null);
	});

	it("exposes them on the patch as well, so a form can turn one off on its own", () => {
		const parsed = updateQueueDto.parse({ ronaEnabled: false });
		expect(parsed).to.deep.equal({ ronaEnabled: false });
	});
});
