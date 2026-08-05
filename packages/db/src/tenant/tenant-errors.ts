/**
 * Raised when tenant-scoped work is attempted without a usable organization id.
 *
 * It carries a `_tag` so Effect failures can be discriminated without importing effect here,
 * and it extends `Error` so the promise-based wrapper can throw the very same instance.
 */
export class TenantDatabaseScopeError extends Error {
	readonly _tag = "TenantDatabaseScopeError" as const;
	readonly contextName: string;
	readonly organizationId: string;

	constructor(input: { contextName: string; organizationId: string }) {
		super(
			`Tenant-scoped work for context "${input.contextName}" requires a non-empty organization id.`,
		);
		this.name = "TenantDatabaseScopeError";
		this.contextName = input.contextName;
		this.organizationId = input.organizationId;
	}
}
