import { describe, expect, it } from "bun:test";
import {
	allocatePostgresConnectionBudget,
	PostgresConnectionBudgetError,
	resolvePostgresRuntimeGuardrails,
} from "./client";

describe("allocatePostgresConnectionBudget", () => {
	it("splits the process budget across the promise and Effect pools without exceeding it", () => {
		const budget = allocatePostgresConnectionBudget(10);

		expect(budget).toEqual({
			maxConnections: 10,
			promisePoolMaxConnections: 5,
			effectPoolMaxConnections: 5,
		});
	});

	it("gives the odd connection to the Effect pool", () => {
		const budget = allocatePostgresConnectionBudget(7);

		expect(budget.promisePoolMaxConnections).toBe(3);
		expect(budget.effectPoolMaxConnections).toBe(4);
		expect(budget.promisePoolMaxConnections + budget.effectPoolMaxConnections).toBe(7);
	});

	it("never allocates a pool of zero", () => {
		const budget = allocatePostgresConnectionBudget(2);

		expect(budget.promisePoolMaxConnections).toBeGreaterThan(0);
		expect(budget.effectPoolMaxConnections).toBeGreaterThan(0);
	});

	it.each([[1], [0], [-4], [2.5], [Number.NaN]])("rejects an unusable budget (%p)", (value) => {
		expect(() => allocatePostgresConnectionBudget(value)).toThrow(PostgresConnectionBudgetError);
	});
});

describe("resolvePostgresRuntimeGuardrails", () => {
	it("applies safe defaults for every timeout", () => {
		const guardrails = resolvePostgresRuntimeGuardrails({
			url: "postgresql://localhost:5432/optimiq_voice",
			applicationName: "optimiq-voice-api",
		});

		expect(guardrails.applicationName).toBe("optimiq-voice-api");
		expect(guardrails.maxConnections).toBe(10);
		expect(guardrails.idleTimeoutSeconds).toBeGreaterThan(0);
		expect(guardrails.connectTimeoutSeconds).toBeGreaterThan(0);
		expect(guardrails.statementTimeoutMs).toBeGreaterThan(0);
		expect(guardrails.idleInTransactionSessionTimeoutMs).toBeGreaterThan(0);
	});

	it("honours explicit overrides", () => {
		const guardrails = resolvePostgresRuntimeGuardrails({
			url: "postgresql://localhost:5432/optimiq_voice",
			applicationName: "optimiq-voice-migrator",
			maxConnections: 4,
			statementTimeoutMs: 1_000,
		});

		expect(guardrails.maxConnections).toBe(4);
		expect(guardrails.promisePoolMaxConnections).toBe(2);
		expect(guardrails.statementTimeoutMs).toBe(1_000);
	});
});
