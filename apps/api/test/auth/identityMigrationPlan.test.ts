import { expect } from "chai";
import {
	classifyAccessKeyId,
	deriveOrganizationSlug,
	findBlockingDefects,
	mapLegacyRole,
	normalizeEmail,
	planMemberships,
	type LegacySnapshot,
	type LegacyWorkspaceMemberRow,
	type LegacyWorkspaceRow,
} from "../../scripts/identity-migration/plan";

/**
 * The mapping rules of the identity-removal Step 2 migration.
 *
 * These are the decisions that can silently break a tenant boundary — a legacy role widened by
 * accident, an owner lost, two workspaces collapsed onto one slug — so they live in a pure module
 * and are pinned here without a database.
 */

const day = (n: number): Date => new Date(Date.UTC(2026, 0, n));

function workspace(overrides: Partial<LegacyWorkspaceRow> = {}): LegacyWorkspaceRow {
	return {
		ref: "ws-1",
		accessKeyId: "WOaaaa",
		name: "Acme Telecom",
		ownerRef: "user-owner",
		createdAt: day(1),
		...overrides,
	};
}

function membership(overrides: Partial<LegacyWorkspaceMemberRow> = {}): LegacyWorkspaceMemberRow {
	return {
		ref: "m-1",
		status: "ACTIVE",
		role: "WORKSPACE_MEMBER",
		userRef: "user-member",
		workspaceRef: "ws-1",
		createdAt: day(2),
		...overrides,
	};
}

describe("@auth/identityMigrationPlan", function () {
	describe("mapLegacyRole", function () {
		it("maps the legacy enum onto better-auth membership roles", function () {
			expect(mapLegacyRole("WORKSPACE_OWNER")).to.equal("owner");
			expect(mapLegacyRole("WORKSPACE_ADMIN")).to.equal("admin");
			expect(mapLegacyRole("WORKSPACE_MEMBER")).to.equal("member");
			expect(mapLegacyRole("USER")).to.equal("member");
		});

		it("never widens an unknown legacy role", function () {
			// Three Prisma migrations preceded the current enum; an unrecognised value must land on
			// least privilege, not on admin.
			expect(mapLegacyRole("SUPER_ADMIN")).to.equal("member");
			expect(mapLegacyRole("")).to.equal("member");
		});
	});

	describe("classifyAccessKeyId", function () {
		it("reads the hardcoded prefixes", function () {
			expect(classifyAccessKeyId("WOabc")).to.equal("workspace");
			expect(classifyAccessKeyId("USabc")).to.equal("user");
			expect(classifyAccessKeyId("APabc")).to.equal("unknown");
		});
	});

	describe("deriveOrganizationSlug", function () {
		it("kebab-cases the workspace name", function () {
			expect(deriveOrganizationSlug("Acme Telecom", new Set())).to.equal("acme-telecom");
		});

		it("strips diacritics and punctuation", function () {
			expect(deriveOrganizationSlug("Télécom Ünïted, Inc.", new Set())).to.equal(
				"telecom-united-inc",
			);
		});

		it("never yields an empty slug", function () {
			expect(deriveOrganizationSlug("!!!", new Set())).to.equal("workspace");
		});

		it("resolves collisions rather than violating the unique index", function () {
			const taken = new Set(["acme-telecom"]);
			const second = deriveOrganizationSlug("Acme Telecom", taken);
			expect(second).to.equal("acme-telecom-2");
			taken.add(second);
			expect(deriveOrganizationSlug("Acme Telecom", taken)).to.equal("acme-telecom-3");
		});
	});

	describe("normalizeEmail", function () {
		it("lowercases and trims, matching better-auth's own lookup", function () {
			expect(normalizeEmail("  Owner@Example.COM ")).to.equal("owner@example.com");
		});
	});

	describe("planMemberships", function () {
		it("synthesises the owner even with no workspace_members row", function () {
			const plan = planMemberships([workspace()], []);
			expect(plan.entries).to.deep.equal([
				{
					workspaceRef: "ws-1",
					userRef: "user-owner",
					role: "owner",
					pending: false,
					createdAt: day(1),
				},
			]);
		});

		it("keeps PENDING rows out of the member list", function () {
			const plan = planMemberships([workspace()], [membership({ status: "PENDING" })]);
			const invitee = plan.entries.find((entry) => entry.userRef === "user-member");
			expect(invitee?.pending).to.equal(true);
		});

		it("gives every workspace exactly one owner", function () {
			// The gate. `workspaces.owner_ref` always wins, even against an ACTIVE
			// WORKSPACE_OWNER row for someone else.
			const plan = planMemberships(
				[workspace()],
				[membership({ ref: "m-2", role: "WORKSPACE_OWNER", userRef: "user-impostor" })],
			);
			const owners = plan.entries.filter((entry) => entry.role === "owner");
			expect(owners).to.have.lengthOf(2, "the impostor keeps its own legacy role");
			expect(plan.entries.find((entry) => entry.userRef === "user-owner")?.role).to.equal("owner");
		});

		it("collapses duplicate rows to the higher privilege and reports it", function () {
			const plan = planMemberships(
				[workspace()],
				[
					membership({ ref: "m-1", role: "WORKSPACE_MEMBER" }),
					membership({ ref: "m-2", role: "WORKSPACE_ADMIN" }),
				],
			);
			const resolved = plan.entries.find((entry) => entry.userRef === "user-member");
			expect(resolved?.role).to.equal("admin");
			expect(plan.warnings.join(" ")).to.contain("duplicate membership");
		});

		it("treats a person who is ACTIVE anywhere as not pending", function () {
			const plan = planMemberships(
				[workspace()],
				[
					membership({ ref: "m-1", status: "PENDING" }),
					membership({ ref: "m-2", status: "ACTIVE" }),
				],
			);
			expect(plan.entries.find((entry) => entry.userRef === "user-member")?.pending).to.equal(
				false,
			);
		});

		it("skips memberships pointing at a workspace that does not exist", function () {
			const plan = planMemberships([workspace()], [membership({ workspaceRef: "ghost" })]);
			expect(plan.entries).to.have.lengthOf(1);
			expect(plan.warnings.join(" ")).to.contain("unknown workspace ghost");
		});
	});

	describe("findBlockingDefects", function () {
		const snapshot = (overrides: Partial<LegacySnapshot> = {}): LegacySnapshot => ({
			users: [
				{
					ref: "user-owner",
					accessKeyId: "USaaa",
					name: "Owner",
					email: "owner@example.com",
					emailVerified: true,
					password: "secret",
					avatar: null,
					createdAt: day(1),
					updatedAt: day(1),
				},
			],
			workspaces: [workspace()],
			workspaceMembers: [],
			apiKeys: [],
			...overrides,
		});

		it("accepts a clean dataset", function () {
			expect(findBlockingDefects(snapshot())).to.deep.equal([]);
		});

		it("refuses a workspace whose owner does not exist", function () {
			const defects = findBlockingDefects(
				snapshot({ workspaces: [workspace({ ownerRef: "ghost" })] }),
			);
			expect(defects.join(" ")).to.contain("who does not exist");
		});

		it("refuses two users sharing an email", function () {
			const base = snapshot();
			const defects = findBlockingDefects({
				...base,
				users: [...base.users, { ...base.users[0], ref: "user-twin", accessKeyId: "USbbb" }],
			});
			expect(defects.join(" ")).to.contain("is shared by legacy users");
		});

		it("refuses a workspace whose access key is not a WO… key", function () {
			const defects = findBlockingDefects(
				snapshot({ workspaces: [workspace({ accessKeyId: "USwrong" })] }),
			);
			expect(defects.join(" ")).to.contain("which is not a WO… key");
		});

		it("refuses an api key pointing at a workspace that does not exist", function () {
			const defects = findBlockingDefects(
				snapshot({
					apiKeys: [
						{
							ref: "k-1",
							accessKeyId: "APaaa",
							accessKeySecret: "s",
							role: "WORKSPACE_ADMIN",
							workspaceRef: "ghost",
							createdAt: day(1),
							expiresAt: null,
						},
					],
				}),
			);
			expect(defects.join(" ")).to.contain("references unknown workspace ghost");
		});
	});
});
