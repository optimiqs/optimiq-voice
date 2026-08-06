import { expect } from "chai";
import {
	diagnosticField,
	isPbxFailure,
	PbxConflictFailure,
	PbxEntityNotFoundFailure,
	PbxEntityReferencedFailure,
	PbxInvalidDestinationFailure,
	RoutingCompileFailure,
	toPbxFailure,
	toWireDiagnostic,
} from "../../src/pbx/shared/pbx.errors";
import type { Diagnostic } from "@optimiq-voice/routing";

/**
 * The HTTP boundary of the PBX area.
 *
 * These bodies are the contract `apps/web` renders, so their shape is pinned here rather than
 * only exercised end to end by `verify-pbx.ts`: a rename that keeps every status code correct and
 * silently drops `code` or `issues` would pass that gate and break every form.
 */
describe("pbx failures", () => {
	it("maps a missing row to a 404 carrying a switchable code", () => {
		const exception = new PbxEntityNotFoundFailure({
			kind: "extension",
			id: "abc",
		}).toHttpException();
		const body = exception.getResponse() as Record<string, unknown>;
		expect(exception.getStatus()).to.equal(404);
		expect(body.code).to.equal("PBX_NOT_FOUND");
		expect(body.kind).to.equal("extension");
		expect(body.id).to.equal("abc");
	});

	it("maps a unique violation to a 409 naming the form field", () => {
		const failure = toPbxFailure("extension", "create", {
			code: "23505",
			constraint_name: "extension_organization_number_key",
			message: "duplicate key",
		});
		expect(failure).to.be.instanceOf(PbxConflictFailure);
		const body = failure.toHttpException().getResponse() as Record<string, unknown>;
		expect(body.code).to.equal("PBX_CONFLICT");
		expect(body.field).to.equal("number");
	});

	it("finds the driver error through drizzle's wrapper", () => {
		// drizzle-orm 1.0 wraps a rejection in `DrizzleQueryError`, so the SQLSTATE is one level down.
		const failure = toPbxFailure("extension", "create", {
			message: "Failed query",
			cause: { code: "23505", constraint_name: "extension_organization_number_key" },
		});
		expect(failure).to.be.instanceOf(PbxConflictFailure);
	});

	it("does not loop on a cyclic cause chain", () => {
		const cyclic: Record<string, unknown> = { message: "boom" };
		cyclic.cause = cyclic;
		const failure = toPbxFailure("extension", "create", cyclic);
		expect(failure._tag).to.equal("PbxDatabaseFailure");
	});

	it("falls back to a 503 for an unrecognised database error", () => {
		const failure = toPbxFailure("trunk", "update", new Error("connection reset"));
		expect(failure.toHttpException().getStatus()).to.equal(503);
	});

	it("lists the referring rows in a 409 delete refusal", () => {
		const failure = new PbxEntityReferencedFailure({
			kind: "ring-group",
			id: "rg",
			references: [{ kind: "ivr-menu-option", id: "opt", name: "Sales", field: "destination_ref" }],
		});
		const body = failure.toHttpException().getResponse() as Record<string, unknown>;
		expect(failure.toHttpException().getStatus()).to.equal(409);
		expect(body.code).to.equal("PBX_REFERENCED");
		expect(body.references).to.have.length(1);
		expect(String(body.message)).to.contain("Sales");
	});

	it("reports destination issues as 422 field errors", () => {
		const failure = new PbxInvalidDestinationFailure({
			issues: [{ field: "destinationRef", code: "dangling", message: "No ring-group with id x." }],
		});
		const exception = failure.toHttpException();
		const body = exception.getResponse() as Record<string, unknown>;
		expect(exception.getStatus()).to.equal(422);
		expect(body.code).to.equal("PBX_INVALID_DESTINATION");
		expect(body.issues).to.have.length(1);
	});

	it("reports only errors in a compile 422, never the warnings", () => {
		const diagnostics: Diagnostic[] = [
			{
				severity: "error",
				code: "dangling-destination",
				message: "points at nothing",
				path: "inboundRoutes[0].destinationRef",
			},
			{ severity: "warning", code: "empty-ring-group", message: "no members" },
		];
		const body = new RoutingCompileFailure({ organizationId: "org", diagnostics })
			.toHttpException()
			.getResponse() as Record<string, unknown>;
		expect(body.code).to.equal("ROUTING_COMPILE_FAILED");
		const wire = body.diagnostics as { code: string; field?: string }[];
		expect(wire).to.have.length(1);
		expect(wire[0]?.code).to.equal("dangling-destination");
		expect(wire[0]?.field).to.equal("destinationRef");
	});

	it("extracts the form field from a diagnostic path, and nothing from a row path", () => {
		expect(diagnosticField("inboundRoutes[3].destinationRef")).to.equal("destinationRef");
		expect(diagnosticField("ringGroups[0]")).to.equal(undefined);
		expect(diagnosticField(undefined)).to.equal(undefined);
	});

	it("keeps a diagnostic's subject on the wire so the UI can deep-link", () => {
		const wire = toWireDiagnostic({
			severity: "warning",
			code: "empty-ring-group",
			message: "no members",
			subject: { kind: "ring-group", id: "rg", name: "Sales" },
		});
		expect(wire.subject?.id).to.equal("rg");
		expect(wire.field).to.equal(undefined);
	});

	it("recognises its own failures when they come back out of a transaction", () => {
		expect(isPbxFailure(new PbxEntityNotFoundFailure({ kind: "trunk", id: "t" }))).to.equal(true);
		expect(isPbxFailure(new Error("nope"))).to.equal(false);
		expect(isPbxFailure({ _tag: "SomethingElse" })).to.equal(false);
	});
});
