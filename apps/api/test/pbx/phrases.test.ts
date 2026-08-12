import { BadRequestException, NotFoundException } from "@nestjs/common";
import { expect } from "chai";
import { getTableName } from "@optimiq-voice/pbx-db";
import { affectsRouting, ROUTING_TABLE_TO_ENTITY } from "@optimiq-voice/routing";
import {
	createPhraseDto,
	createPhraseStepDto,
	updatePhraseDto,
	updatePhraseStepDto,
} from "../../src/pbx/phrases/phrases.dto";
import { PHRASE_RESOURCE, PHRASE_STEP_RESOURCE } from "../../src/pbx/phrases/phrases.resource";
import { requirePhrase, requireStepTarget } from "../../src/pbx/phrases/phrases.service";
import { PROMPT_RESOURCE } from "../../src/pbx/prompts/prompts.resource";
import { parseDto } from "../../src/pbx/shared/dto";
import type { PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

/**
 * The phrase surface.
 *
 * A phrase is the one row in this system whose IDENTITY is a discriminator: it is a `prompt` row
 * with `kind = "phrase"` and no file, sharing a table with the media library so that the eight
 * `*_prompt_id` foreign keys can hold either. Everything asserted here follows from that one fact
 * and is a place the surface could be wrong in a way no integration test would obviously catch:
 *
 * 1. **`kind` and `objectKey` are not fields.** A client that could send either could produce a
 *    library entry with no audio behind it, which is the row `prompt_object_key_kind_check` exists
 *    to prevent — and which every player would then have to guard against.
 * 2. **Nesting is refused at write time, with a field named.** The compiler refuses it too, as an
 *    `invalid-phrase` error, but that arrives as a rollback on a save the user already made.
 * 3. **The discriminator is enforced on every path**, so a library prompt's id is a 404 under
 *    `/phrases/:id` rather than a metadata edit that happens to work.
 * 4. **The delete guard covers the ninth pointer.** `phrase_step.prompt_id` is the one
 *    `on delete restrict` column in this schema; undeclared, it would fall past `toPbxFailure`'s
 *    unique/check arms into `PbxDatabaseFailure` — a 503 telling a user the database is down when
 *    what actually happened is that three phrases still play the file they tried to delete.
 *
 * The SQL is `verify-pbx.ts`'s job, against a real database.
 */

const PROMPT_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";

describe("the phrase resources", () => {
	it("names the prompt table, because a phrase IS a prompt row", () => {
		expect(PHRASE_RESOURCE.tableName).to.equal("prompt");
		expect(getTableName(PHRASE_RESOURCE.table)).to.equal(PHRASE_RESOURCE.tableName);
		expect(getTableName(PHRASE_STEP_RESOURCE.table)).to.equal(PHRASE_STEP_RESOURCE.tableName);
		// The same table as the library, and a different entity name — which is the whole of what the
		// descriptor can express about the difference. The rest is a predicate on every read.
		expect(PHRASE_RESOURCE.table).to.equal(PROMPT_RESOURCE.table);
		expect(PHRASE_RESOURCE.kind).to.not.equal(PROMPT_RESOURCE.kind);
	});

	/**
	 * Both halves are routing inputs, so a save reaches the engine. `prompt` became one the day a
	 * phrase became a prompt row: which ids are SEQUENCES is a compiled fact.
	 */
	it("is a routing input on both halves, so a save recompiles the artifact", () => {
		for (const tableName of [PHRASE_RESOURCE.tableName, PHRASE_STEP_RESOURCE.tableName]) {
			expect(affectsRouting(tableName), tableName).to.equal(true);
			expect(ROUTING_TABLE_TO_ENTITY[tableName], tableName).to.be.a("string");
		}
	});

	/** The ordinal is the sentence, so the collection earns its `PUT …/reorder`. */
	it("orders steps by an ordinal, which is what makes the sequence editable", () => {
		expect(PHRASE_STEP_RESOURCE.ordinalColumn).to.not.equal(undefined);
		expect(PHRASE_STEP_RESOURCE.parentKind).to.equal("phrase");
		expect(getTableName(PHRASE_STEP_RESOURCE.parentTable)).to.equal("prompt");
	});

	/**
	 * A phrase is reached by the same eight columns a file is. `phrase_step.prompt_id` is absent
	 * BECAUSE nesting is refused: no step can ever name a phrase, so the scan would be provably
	 * empty and its presence would suggest otherwise to a reader.
	 */
	it("guards a phrase with the library's eight pointers and not the ninth", () => {
		const sites = PHRASE_RESOURCE.scalarReferences ?? [];
		expect(sites).to.have.lengthOf(8);
		expect(sites.some((site) => site.table === "phrase_step")).to.equal(false);
	});

	/**
	 * And the library carries the ninth. `idColumn` is the point of the assertion: the reference has
	 * to name the PHRASE, because a step has no screen to send the user to.
	 */
	it("guards a library prompt with the phrase_step pointer, naming the phrase", () => {
		const site = (PROMPT_RESOURCE.scalarReferences ?? []).find(
			(entry) => entry.table === "phrase_step",
		);
		expect(site, "phrase_step is not declared on the prompt resource").to.not.equal(undefined);
		expect(site?.column).to.equal("prompt_id");
		expect(site?.idColumn).to.equal("phrase_id");
		expect(site?.kind).to.equal("phrase");
	});
});

describe("phrase DTOs", () => {
	it("creates a phrase from a name and nothing else", () => {
		expect(parseDto(createPhraseDto, { name: "Queue position" })).to.deep.equal({
			name: "Queue position",
		});
	});

	/**
	 * The pair that MAKES the row a phrase, refused from both bodies. `kind` would let a client turn
	 * a sequence into a library entry; `objectKey` is the column the upload path writes from the
	 * bytes it actually stored, and accepting it would let an admin re-point a row at another
	 * tenant's object by editing a string.
	 */
	it("refuses the two fields that are not fields but an identity", () => {
		for (const body of [
			{ name: "Queue position", kind: "prompt" },
			{ name: "Queue position", objectKey: "prompt/other-tenant/x.wav" },
			{ name: "Queue position", mohClassId: PROMPT_ID },
			{ name: "Queue position", language: "en-US" },
		]) {
			expect(() => parseDto(createPhraseDto, body), JSON.stringify(body)).to.throw(
				BadRequestException,
			);
		}
		expect(() => parseDto(updatePhraseDto, { kind: "phrase" })).to.throw(BadRequestException);
		expect(() => parseDto(updatePhraseDto, { objectKey: null })).to.throw(BadRequestException);
	});

	it("takes a step as a prompt id and an ordinal, and lets a patch move either", () => {
		expect(parseDto(createPhraseStepDto, { promptId: PROMPT_ID, ordinal: 0 })).to.deep.equal({
			promptId: PROMPT_ID,
			ordinal: 0,
		});
		expect(parseDto(updatePhraseStepDto, { ordinal: 3 })).to.deep.equal({ ordinal: 3 });
	});

	/** A step with no audio is not a step, which is why `promptId` is required and not nullable. */
	it("refuses a step with no target, and a target that is not an id", () => {
		expect(() => parseDto(createPhraseStepDto, { ordinal: 0 })).to.throw(BadRequestException);
		expect(() => parseDto(createPhraseStepDto, { promptId: null, ordinal: 0 })).to.throw(
			BadRequestException,
		);
		expect(() => parseDto(updatePhraseStepDto, { promptId: "the-hold-music" })).to.throw(
			BadRequestException,
		);
	});
});

/**
 * The two checks the descriptor cannot make, over a fake transaction.
 *
 * Asserting on the SQL would be asserting on Drizzle. What is asserted is the DECISION each one
 * makes from a row it was handed, which is the part that has to be right.
 */
describe("the phrase discriminator", () => {
	function fakeTransaction(rows: readonly Record<string, unknown>[]): PbxDatabaseTransaction {
		return {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: () => ({
							then: (resolve: (value: unknown) => void) => {
								resolve([...rows]);
							},
						}),
					}),
				}),
			}),
		} as unknown as PbxDatabaseTransaction;
	}

	it("returns the row when it is a phrase", async () => {
		const row = { id: PROMPT_ID, name: "Queue position", kind: "phrase", objectKey: null };
		expect(await requirePhrase(fakeTransaction([row]), PROMPT_ID)).to.deep.equal(row);
	});

	/**
	 * RLS has already scoped the read, so "absent", "another tenant's" and "a library file" reach
	 * this line as one case and are answered identically. A library prompt reaching `/phrases/:id`
	 * is a 404 and not a redirect: the two share a table, so a caller holding one id effectively
	 * holds all of them, and answering for a file would make the noun in the URL decoration.
	 */
	it("is a 404 for an id that is not a phrase in this tenant", async () => {
		await expectRejection(
			() => requirePhrase(fakeTransaction([]), PROMPT_ID),
			NotFoundException,
			"PBX_NOT_FOUND",
		);
	});

	it("accepts a step target that is ordinary audio", async () => {
		await requireStepTarget(fakeTransaction([{ kind: "prompt", name: "Seven" }]), PROMPT_ID);
		await requireStepTarget(fakeTransaction([{ kind: "greeting", name: "Welcome" }]), PROMPT_ID);
	});

	/**
	 * The nesting refusal, and the reason it is a 400 rather than a 404: the row IS there and the
	 * caller is probably looking at it in a picker. Telling them it does not exist would send them
	 * hunting for a row they can see. The field is named so the message lands on that picker.
	 */
	it("refuses a step that names another phrase, naming the field", async () => {
		const error = await expectRejection(
			() => requireStepTarget(fakeTransaction([{ kind: "phrase", name: "Greeting" }]), PROMPT_ID),
			BadRequestException,
			"PBX_VALIDATION_FAILED",
		);
		const body = error.getResponse() as { field: string; message: string };
		expect(body.field).to.equal("promptId");
		expect(body.message).to.contain("do not nest");
		expect(body.message).to.contain("Greeting");
	});

	/** A target that is not in the tenant is the ordinary dangling-reference answer. */
	it("is a 404 for a step target that is not there at all", async () => {
		await expectRejection(
			() => requireStepTarget(fakeTransaction([]), PROMPT_ID),
			NotFoundException,
			"PBX_NOT_FOUND",
		);
	});
});

async function expectRejection<T extends { getResponse: () => unknown }>(
	work: () => Promise<unknown>,
	type: new (...args: never[]) => T,
	code: string,
): Promise<T> {
	let caught: unknown;
	try {
		await work();
	} catch (error) {
		caught = error;
	}
	expect(caught, `expected a ${type.name}`).to.be.instanceOf(type);
	const error = caught as T;
	expect((error.getResponse() as { code: string }).code).to.equal(code);
	return error;
}
