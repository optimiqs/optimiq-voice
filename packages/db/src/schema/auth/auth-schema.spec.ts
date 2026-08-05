import { describe, expect, it } from "bun:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { authSchema } from "./index";

/**
 * better-auth 1.6.23 resolves Drizzle tables as `schema[model]` and columns as
 * `schema[model][field]`, so the object keys and the column property keys are a wire contract.
 * These fields were produced by `getAuthTables()` for exactly the plugin set configured in
 * @optimiq-voice/auth; regenerate them before bumping better-auth.
 */
const REQUIRED_FIELDS: Record<string, readonly string[]> = {
	user: [
		"id",
		"name",
		"email",
		"emailVerified",
		"image",
		"createdAt",
		"updatedAt",
		"role",
		"banned",
		"banReason",
		"banExpires",
		"twoFactorEnabled",
	],
	session: [
		"id",
		"expiresAt",
		"token",
		"createdAt",
		"updatedAt",
		"ipAddress",
		"userAgent",
		"userId",
		"activeOrganizationId",
		"impersonatedBy",
	],
	account: [
		"id",
		"accountId",
		"providerId",
		"userId",
		"accessToken",
		"refreshToken",
		"idToken",
		"accessTokenExpiresAt",
		"refreshTokenExpiresAt",
		"scope",
		"password",
		"createdAt",
		"updatedAt",
	],
	verification: ["id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"],
	organization: ["id", "name", "slug", "logo", "createdAt", "metadata"],
	member: ["id", "organizationId", "userId", "role", "createdAt"],
	invitation: [
		"id",
		"organizationId",
		"email",
		"role",
		"status",
		"expiresAt",
		"createdAt",
		"inviterId",
	],
	apikey: [
		"id",
		"configId",
		"name",
		"start",
		"referenceId",
		"prefix",
		"key",
		"refillInterval",
		"refillAmount",
		"lastRefillAt",
		"enabled",
		"rateLimitEnabled",
		"rateLimitTimeWindow",
		"rateLimitMax",
		"requestCount",
		"remaining",
		"lastRequest",
		"expiresAt",
		"createdAt",
		"updatedAt",
		"permissions",
		"metadata",
	],
	twoFactor: [
		"id",
		"secret",
		"backupCodes",
		"userId",
		"verified",
		"failedVerificationCount",
		"lockedUntil",
	],
	jwks: ["id", "publicKey", "privateKey", "createdAt", "expiresAt"],
};

const EXPECTED_TABLE_NAMES: Record<string, string> = {
	account: "account",
	apikey: "api_key",
	invitation: "invitation",
	jwks: "jwks",
	member: "member",
	organization: "organization",
	session: "session",
	twoFactor: "two_factor",
	user: "user",
	verification: "verification",
};

describe("better-auth drizzle schema", () => {
	it("exports exactly the models the configured plugin set needs", () => {
		expect(Object.keys(authSchema).sort()).toEqual(Object.keys(REQUIRED_FIELDS).sort());
	});

	it.each(Object.entries(REQUIRED_FIELDS))(
		"exposes every %s field the adapter looks up",
		(model, fields) => {
			const table = authSchema[model as keyof typeof authSchema];
			const columnKeys = Object.keys(getTableColumns(table));

			for (const field of fields) {
				expect(columnKeys).toContain(field);
			}
		},
	);

	it.each(Object.entries(EXPECTED_TABLE_NAMES))(
		"maps model %s to physical table %s",
		(model, tableName) => {
			expect(String(getTableName(authSchema[model as keyof typeof authSchema]))).toBe(tableName);
		},
	);

	it("uses snake_case physical column names throughout", () => {
		for (const table of Object.values(authSchema)) {
			for (const column of Object.values(getTableColumns(table))) {
				expect(column.name).toMatch(/^[a-z][a-z0-9_]*$/u);
			}
		}
	});

	it("gives every table a uuid primary key with an application-side default", () => {
		for (const table of Object.values(authSchema)) {
			const columns = getTableColumns(table);
			const id = columns.id;
			expect(id).toBeDefined();
			expect(id?.primary).toBe(true);
			expect(id?.columnType).toBe("PgUUID");
			expect(id?.hasDefault).toBe(true);
		}
	});
});
