import { expect } from "chai";
import { isEncryptedSecret, SECRET_ENCRYPTION_KEY_VARIABLE } from "@optimiq-voice/db";
import { kycDecisionDto, upsertKycDto } from "../../src/compliance/kyc/kyc.dto";
import { kycAmendment, taxIdLast4 } from "../../src/compliance/kyc/kyc.rules";
import { ComplianceKycService } from "../../src/compliance/kyc/kyc.service";
import { PlatformKycService } from "../../src/compliance/kyc/platform-kyc.service";
import { parseDto } from "../../src/pbx/shared/dto";
import type { AuthRepository } from "../../src/auth/auth.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The know-your-customer file: the encryption, the amendment rule, and the reviewer's write.
 *
 * ## The database is a hand-written double, and the assertions are about the VALUES
 *
 * `carrierPorting.test.ts` sets the precedent for this shape — services constructed with `new`,
 * collaborators supplied as doubles through `as unknown as` — and the reasoning transfers exactly:
 * the things most likely to be wrong here are *what gets written* (is the tax id ciphertext? did the
 * decision reset?) and *what comes back* (is the plaintext absent?), and standing up `pbx-db` to
 * check those would test Drizzle. The double captures every insert and every audit row, which is
 * what makes both questions directly assertable.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OPERATOR_ORG = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
/** 32 bytes of hex — a fixture key, and the only key this file ever uses. */
const KEY = "0".repeat(64);

function session(organizationId: string = ORG): AppSession {
	return {
		session: { activeOrganizationId: organizationId, userId: USER },
		user: { id: USER, role: "owner" },
	} as unknown as AppSession;
}

const FILE = {
	legalEntityName: "Acme Communications Ltd",
	entityType: "private-company",
	taxId: "12-3456789",
	addressLine1: "1 Example Way",
	addressCity: "Lisbon",
	addressCountry: "pt",
	contactName: "Ada Lovelace",
	contactEmail: "ada@example.com",
} as const;

/**
 * A `PbxDatabaseClient` that records what the service asks it to write.
 *
 * `withTenantScope` runs the callback against a transaction stub rather than a pool. The stub
 * implements only the four builder shapes this service reaches for; anything else would be a query
 * the service is not supposed to be making, and a missing method fails loudly, which is the point.
 */
function databaseDouble(existing?: Record<string, unknown>) {
	const written: Record<string, unknown>[] = [];
	const audits: Record<string, unknown>[] = [];
	let row: Record<string, unknown> | undefined = existing;

	const transaction = {
		select(columns: Record<string, unknown>) {
			return {
				from() {
					return {
						where() {
							return {
								limit: async () => (row === undefined ? [] : [project(row, columns)]),
							};
						},
					};
				},
			};
		},
		insert() {
			return {
				values(values: Record<string, unknown>) {
					return {
						onConflictDoUpdate(spec: { set: Record<string, unknown> }) {
							return {
								// Projected, exactly as `.returning(KYC_RESPONSE_COLUMNS)` does — which is what
								// makes "the plaintext is absent from the response" a real assertion rather
								// than an artefact of the double.
								returning: async (columns: Record<string, unknown>) => {
									row = { ...(row ?? {}), ...values, ...spec.set, id: row?.id ?? "kyc-1" };
									written.push({ ...row });
									return [project(row, columns)];
								},
							};
						},
						// The audit ledger's insert has no `onConflictDoUpdate` and no `returning`; it is
						// awaited directly, which is what this thenable serves.
						then: (resolve: (value: unknown) => void) => {
							audits.push(values);
							resolve(undefined);
						},
					};
				},
			};
		},
		update() {
			return { set: () => ({ where: async () => undefined }) };
		},
	};

	const client = {
		withTenantScope: async <T>(_org: string, work: (tx: unknown) => Promise<T>): Promise<T> =>
			await work(transaction),
		adminDb: {
			update() {
				return {
					set(values: Record<string, unknown>) {
						return {
							where() {
								return {
									returning: async (columns: Record<string, unknown>) => {
										if (row === undefined) {
											return [];
										}
										row = { ...row, ...values };
										written.push({ ...row });
										return [project(row, columns)];
									},
								};
							},
						};
					},
				};
			},
		},
	} as unknown as PbxDatabaseClient;

	return { client, written, audits, current: () => row };
}

/** The service selects explicit columns; the double honours that so `taxId` absence is real. */
function project(
	row: Record<string, unknown>,
	columns: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(columns)) {
		out[key] = row[key] ?? null;
	}
	return out;
}

function authDouble(name: string | null): AuthRepository {
	return {
		findOrganizationById: async () => (name === null ? null : { id: ORG, name }),
	} as unknown as AuthRepository;
}

describe("the KYC write path", () => {
	let previousKey: string | undefined;

	beforeEach(() => {
		previousKey = process.env[SECRET_ENCRYPTION_KEY_VARIABLE];
		process.env[SECRET_ENCRYPTION_KEY_VARIABLE] = KEY;
	});

	afterEach(() => {
		if (previousKey === undefined) {
			delete process.env[SECRET_ENCRYPTION_KEY_VARIABLE];
		} else {
			process.env[SECRET_ENCRYPTION_KEY_VARIABLE] = previousKey;
		}
	});

	it("stores the tax id as ciphertext and never returns the plaintext", async () => {
		const database = databaseDouble();
		const service = new ComplianceKycService(database.client);

		const result = await service.upsert(session(), parseDto(upsertKycDto, FILE));

		const stored = database.current();
		expect(typeof stored?.taxId).to.equal("string");
		expect(isEncryptedSecret(String(stored?.taxId))).to.equal(true);
		expect(String(stored?.taxId)).to.not.contain("3456789");
		// The readable half survives, and it is the DIGITS of the identifier rather than its
		// punctuation — `12-3456789` and `123456789` are the same EIN.
		expect(stored?.taxIdLast4).to.equal("6789");
		// The response carries the remainder and nothing else.
		expect(Object.hasOwn(result.data, "taxId")).to.equal(false);
		expect(result.data.taxIdLast4).to.equal("6789");
	});

	it("refuses a tax id when the deployment has no envelope key, rather than storing it in the clear", async () => {
		delete process.env[SECRET_ENCRYPTION_KEY_VARIABLE];
		const database = databaseDouble();
		const service = new ComplianceKycService(database.client);

		let refused = false;
		try {
			await service.upsert(session(), parseDto(upsertKycDto, FILE));
		} catch (error) {
			refused = true;
			expect((error as { getStatus: () => number }).getStatus()).to.equal(501);
		}
		expect(refused, "the write should have been refused").to.equal(true);
		expect(database.current(), "nothing should have been written").to.equal(undefined);
	});

	it("leaves the stored tax id alone when the body omits the key", async () => {
		const database = databaseDouble();
		const service = new ComplianceKycService(database.client);
		await service.upsert(session(), parseDto(upsertKycDto, FILE));
		const sealed = database.current()?.taxId;

		const { taxId: _omitted, ...withoutTaxId } = FILE;
		await service.upsert(session(), parseDto(upsertKycDto, withoutTaxId));

		expect(database.current()?.taxId).to.equal(sealed);
		expect(database.current()?.taxIdLast4).to.equal("6789");
	});

	it("resets a decided file to pending and clears the reviewer when a tenant amends it", async () => {
		const database = databaseDouble({
			id: "kyc-1",
			organizationId: ORG,
			decision: "approved",
			reviewedBy: USER,
			reviewedAt: new Date("2026-01-01T00:00:00.000Z"),
			reviewNotes: "looks fine",
		});
		const service = new ComplianceKycService(database.client);

		const result = await service.upsert(
			session(),
			parseDto(upsertKycDto, { ...FILE, legalEntityName: "Acme Communications PLC" }),
		);

		expect(result.data.decision).to.equal("pending");
		expect(result.data.reviewedBy).to.equal(null);
		expect(result.data.reviewedAt).to.equal(null);
		expect(result.data.reviewNotes).to.equal(null);
		expect(database.audits.length, "the amendment should be in the ledger").to.be.greaterThan(0);
	});

	it("refuses a tenant that tries to write its own verdict", () => {
		for (const forbidden of ["decision", "reviewedBy", "reviewedAt", "reviewNotes"]) {
			const parsed = upsertKycDto.safeParse({ ...FILE, [forbidden]: "approved" });
			expect(parsed.success, `${forbidden} must not be accepted`).to.equal(false);
		}
	});
});

describe("the KYC amendment rule", () => {
	it("resets every decided state, and leaves a pending or absent file alone", () => {
		for (const decision of ["approved", "rejected", "needs-info"] as const) {
			expect(kycAmendment({ decision })?.decision).to.equal("pending");
			expect(kycAmendment({ decision })?.reviewedBy).to.equal(null);
		}
		expect(kycAmendment({ decision: "pending" })).to.equal(undefined);
		expect(kycAmendment(undefined)).to.equal(undefined);
	});

	it("derives the last four DIGITS, whatever the punctuation", () => {
		expect(taxIdLast4("12-3456789")).to.equal("6789");
		expect(taxIdLast4("123456789")).to.equal("6789");
		expect(taxIdLast4("PT 501 442 600")).to.equal("2600");
		// Letter-heavy identifiers fall back to characters rather than producing an empty column.
		expect(taxIdLast4("GB-VATX")).to.equal("VATX");
		expect(taxIdLast4(null)).to.equal(null);
	});
});

describe("the platform KYC review", () => {
	it("writes the reviewer, the instant and the notes, and files it under the reviewed tenant", async () => {
		const database = databaseDouble({
			id: "kyc-1",
			organizationId: ORG,
			decision: "pending",
			reviewedBy: null,
			reviewedAt: null,
			reviewNotes: null,
		});
		const service = new PlatformKycService(database.client, authDouble("Acme Communications"));

		const result = await service.decide(
			session(OPERATOR_ORG),
			ORG,
			parseDto(kycDecisionDto, { decision: "approved", reviewNotes: "documents verified" }),
		);

		expect(result.data.decision).to.equal("approved");
		expect(result.data.reviewedBy).to.equal(USER);
		expect(result.data.reviewedAt).to.be.instanceOf(Date);
		expect(result.data.reviewNotes).to.equal("documents verified");
		// The tenant sees the verdict reached about it in its own change history.
		expect(database.audits[0]?.organizationId).to.equal(ORG);
		expect(database.audits[0]?.action).to.equal("compliance-kyc.decision");
		// And the reviewer is the ACTOR, never the subject.
		expect(database.audits[0]?.actorUserId).to.equal(USER);
	});

	it("refuses a decision on an organization that has filed nothing", async () => {
		const database = databaseDouble();
		const service = new PlatformKycService(database.client, authDouble(null));
		let refused = false;
		try {
			await service.decide(
				session(OPERATOR_ORG),
				ORG,
				parseDto(kycDecisionDto, { decision: "approved" }),
			);
		} catch (error) {
			refused = true;
			expect((error as { getStatus: () => number }).getStatus()).to.equal(404);
		}
		expect(refused).to.equal(true);
	});
});
