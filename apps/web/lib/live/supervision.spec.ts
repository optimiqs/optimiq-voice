import { describe, expect, it } from "bun:test";
import { SUPERVISE_MODES, describeSupervision, type SupervisionResult } from "./supervision";

/**
 * What a supervisor is told after pressing Monitor, Whisper or Barge.
 *
 * These assertions are the honesty of the feature rather than its wording. `*0` connects the
 * supervisor SILENT whatever mode they asked for, and the requested mode is reached by sending a
 * DTMF digit from their own handset. A sentence that implied the mode had been applied would leave
 * somebody believing they had joined a call the customer cannot hear them on — so the two things
 * that must always be in it are that the arrival is silent, and which digit changes that.
 */
function result(overrides: Partial<SupervisionResult> = {}): SupervisionResult {
	return {
		ok: true,
		escalationDigit: "5",
		mode: "whisper",
		agentId: "019fd3c2-1111-76be-a6b3-b0f1914e39b6",
		agentExtension: "1001",
		supervisorExtension: "1900",
		callId: "019fd3c2-2222-76be-a6b3-b0f1914e39b6",
		...overrides,
	};
}

describe("describeSupervision", () => {
	it("says the arrival is silent, in every mode", () => {
		for (const mode of SUPERVISE_MODES) {
			expect(describeSupervision(result({ mode }))).toContain("silently");
		}
	});

	it("names the digit that reaches the requested mode", () => {
		expect(describeSupervision(result({ mode: "whisper", escalationDigit: "5" }))).toContain(
			"press 5",
		);
		expect(describeSupervision(result({ mode: "barge", escalationDigit: "6" }))).toContain(
			"press 6",
		);
	});

	/** Monitor still names one: `4` is what RETURNS to silence after a whisper or a barge. */
	it("gives monitor a digit too, because it is the way back from the other two", () => {
		const said = describeSupervision(result({ mode: "monitor", escalationDigit: "4" }));
		expect(said).toContain("4");
		expect(said).toContain("silent");
	});

	/**
	 * A barge is the one that changes what the CALLER hears, and the sentence has to say so — the
	 * whisper's does not, because a whisper deliberately does not reach them.
	 */
	it("says who hears the supervisor once they escalate", () => {
		expect(describeSupervision(result({ mode: "barge" }))).toContain("both sides hear you");
		expect(describeSupervision(result({ mode: "whisper" }))).toContain("agent alone");
	});

	it("names both extensions, so the supervisor knows which phone rings", () => {
		const said = describeSupervision(result());
		expect(said).toContain("1900");
		expect(said).toContain("1001");
	});
});
