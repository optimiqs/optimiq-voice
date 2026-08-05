import {
	decryptStringSync,
	encryptStringSync,
	findKeyForMessage,
	makeKeychainSync,
	parseCloakedString,
	parseKeySync,
} from "@47ng/cloak";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { getLogger } from "@optimiq-voice/logger";
import { CLOAK_ENCRYPTION_KEY } from "../envs";
import * as schema from "./db/schema";
import { API_TENANT_ORGANIZATION_SETTING, API_TENANT_ROLE_NAME } from "./db/tenant";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

const DATABASE_ALREADY_EXISTS = "DATABASE_ALREADY_EXISTS" as const;
const DATABASE_NOT_FOUND = "DATABASE_NOT_FOUND" as const;

type DatabaseErrorCode = typeof DATABASE_ALREADY_EXISTS | typeof DATABASE_NOT_FOUND;

class DatabaseError extends Error {
	code: DatabaseErrorCode;

	constructor(code: DatabaseErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "DatabaseError";
	}
}

type Application = typeof schema.applications.$inferSelect;
type Secret = typeof schema.secrets.$inferSelect;
type Service = typeof schema.textToSpeechServices.$inferSelect;
type Product = typeof schema.products.$inferSelect;
type ProductInput = typeof schema.products.$inferInsert;

type ServiceCreate = {
	create: {
		ref?: string;
		productRef: string;
		credentials?: string | null;
		config: unknown;
	};
};

type ApplicationData = Partial<Pick<Application, "ref" | "name" | "type" | "endpoint">> & {
	organizationId?: string;
	textToSpeech?: ServiceCreate;
	speechToText?: ServiceCreate;
	intelligence?: ServiceCreate;
};

type ApplicationInclude = {
	textToSpeech?: boolean;
	speechToText?: boolean;
	intelligence?: boolean;
};

type ApplicationResult = Application & {
	textToSpeech?: Service | null;
	speechToText?: Service | null;
	intelligence?: Service | null;
};

type FindUniqueApplicationArgs = {
	where: { ref: string; organizationId?: string };
	include?: ApplicationInclude;
};

type FindManyApplicationArgs = {
	where: { organizationId: string };
	include?: ApplicationInclude;
	take: number;
	skip?: number;
	cursor?: { ref: string };
};

type SecretData = Partial<Pick<Secret, "name" | "secret">> & {
	ref?: string;
	organizationId?: string;
};

type FindManySecretArgs = {
	where: { organizationId: string };
	take: number;
	skip?: number;
	cursor?: { ref: string };
};

/**
 * drizzle 1.0 parameterises `NodePgDatabase` by the *relations* graph rather than by the table
 * map, so the handle type is `NodePgDatabase<typeof schema.relations>`. The query-builder methods
 * this facade uses (`select` / `insert` / `update` / `delete`) are unchanged.
 */
type ApiDatabase = NodePgDatabase<typeof schema.relations>;

type DrizzleExecutor = Pick<ApiDatabase, "delete" | "insert" | "select" | "update">;

type ApplicationDelegate = {
	create(args: { data: ApplicationData }): Promise<Application>;
	delete(args: { where: { ref: string } }): Promise<Application>;
	findMany(args: FindManyApplicationArgs): Promise<ApplicationResult[]>;
	findUnique(args: FindUniqueApplicationArgs): Promise<ApplicationResult | null>;
	update(args: {
		where: { ref: string; organizationId?: string };
		data: ApplicationData;
	}): Promise<Application>;
};

type SecretDelegate = {
	create(args: { data: SecretData }): Promise<Secret>;
	delete(args: { where: { ref: string } }): Promise<Secret>;
	findMany(args: FindManySecretArgs): Promise<Secret[]>;
	findUnique(args: { where: { ref: string } }): Promise<Secret | null>;
	update(args: { where: { ref: string }; data: SecretData }): Promise<Secret>;
};

type ServiceDelegate = {
	deleteMany(args: { where: { applicationRef: string } }): Promise<{
		count: number;
	}>;
};

type ProductDelegate = {
	upsert(args: {
		where: { ref: string };
		update: Partial<Omit<ProductInput, "ref">>;
		create: ProductInput;
	}): Promise<Product>;
};

/**
 * The organization-scoped half of {@link Database} — identity-removal **Step 5 item 4**.
 *
 * `product` is absent because the product catalogue is platform-global: it is seeded at boot by
 * the owning principal, carries no `organization_id`, and has neither a grant nor a policy for
 * `api_tenant_tls`. A tenant transaction that touched it would be denied by PostgreSQL, so the
 * type refuses it first.
 */
type TenantDatabase = Pick<
	Database,
	"application" | "secret" | "textToSpeech" | "speechToText" | "intelligence"
> & {
	readonly organizationId: string;
	transaction<T>(callback: (database: TenantDatabase) => Promise<T>): Promise<T>;
};

type Database = {
	application: ApplicationDelegate;
	secret: SecretDelegate;
	textToSpeech: ServiceDelegate;
	speechToText: ServiceDelegate;
	intelligence: ServiceDelegate;
	product: ProductDelegate;
	transaction<T>(callback: (database: Database) => Promise<T>): Promise<T>;
	/**
	 * Every statement runs inside one transaction that has dropped into `api_tenant_tls` and
	 * published `organizationId` as a transaction-local setting, so row-level security — not
	 * application code — decides what is visible.
	 */
	forOrganization(organizationId: string): TenantDatabase;
	close(): Promise<void>;
};

/** Raised when tenant-scoped work is attempted without a usable organization id. */
class TenantScopeError extends Error {
	readonly _tag = "TenantScopeError" as const;

	constructor() {
		super("Tenant-scoped database work requires a non-empty organization id.");
		this.name = "TenantScopeError";
	}
}

function requireOrganizationId(organizationId: string | undefined | null): string {
	const trimmed = (organizationId ?? "").trim();
	if (trimmed.length === 0) {
		throw new TenantScopeError();
	}
	return trimmed;
}

const encryptionKey = parseKeySync(CLOAK_ENCRYPTION_KEY);
const decryptionKeys = Array.from(
	new Set([
		CLOAK_ENCRYPTION_KEY,
		...(process.env.PRISMA_FIELD_DECRYPTION_KEYS ?? "").split(",").filter(Boolean),
	]),
);
const keychain = makeKeychainSync(decryptionKeys);

function encrypt(value: string | null | undefined) {
	return value == null ? value : encryptStringSync(value, encryptionKey);
}

function decrypt(value: string | null) {
	if (value == null || !parseCloakedString(value)) {
		return value;
	}

	try {
		return decryptStringSync(value, findKeyForMessage(value, keychain));
	} catch (error) {
		logger.error("failed to decrypt database field; returning ciphertext", {
			error,
		});
		return value;
	}
}

function decryptService(service: Service | null): Service | null {
	return service ? { ...service, credentials: decrypt(service.credentials) } : null;
}

function decryptSecret(secret: Secret): Secret {
	return { ...secret, secret: decrypt(secret.secret) };
}

function notFound(resource: string) {
	return new DatabaseError(DATABASE_NOT_FOUND, `${resource} not found`);
}

function hasErrorCode(error: unknown, code: string): boolean {
	const seen = new Set<object>();
	let current = error;

	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const value = current as { cause?: unknown; code?: unknown };
		if (value.code === code) {
			return true;
		}
		current = value.cause;
	}

	return false;
}

function normalizeError(error: unknown): never {
	if (hasErrorCode(error, "23505")) {
		throw new DatabaseError(DATABASE_ALREADY_EXISTS, "The resource already exists");
	}

	throw error;
}

function getPoolConfig(databaseUrl: string) {
	const url = new URL(databaseUrl);
	const databaseSchema = url.searchParams.get("schema") ?? "public";
	if (!/^[a-z_][a-z0-9_]*$/.test(databaseSchema)) {
		throw new Error(`Invalid PostgreSQL schema: ${databaseSchema}`);
	}
	url.searchParams.delete("schema");

	return {
		connectionString: url.toString(),
		options: `-c search_path=${databaseSchema},public`,
	};
}

function applicationConditions(where: { ref: string; organizationId?: string }) {
	return where.organizationId
		? and(
				eq(schema.applications.ref, where.ref),
				eq(schema.applications.organizationId, where.organizationId),
			)
		: eq(schema.applications.ref, where.ref);
}

async function includeApplicationRelations(
	executor: DrizzleExecutor,
	rows: Application[],
	include?: ApplicationInclude,
): Promise<ApplicationResult[]> {
	if (!include || rows.length === 0) {
		return rows;
	}

	const refs = rows.map(({ ref }) => ref);
	const [textToSpeech, speechToText, intelligence] = await Promise.all([
		include.textToSpeech
			? executor
					.select()
					.from(schema.textToSpeechServices)
					.where(inArray(schema.textToSpeechServices.applicationRef, refs))
			: [],
		include.speechToText
			? executor
					.select()
					.from(schema.speechToTextServices)
					.where(inArray(schema.speechToTextServices.applicationRef, refs))
			: [],
		include.intelligence
			? executor
					.select()
					.from(schema.intelligenceServices)
					.where(inArray(schema.intelligenceServices.applicationRef, refs))
			: [],
	]);

	const byApplicationRef = (services: Service[]) =>
		new Map(services.map((service) => [service.applicationRef, decryptService(service)]));
	const textToSpeechByApplication = byApplicationRef(textToSpeech);
	const speechToTextByApplication = byApplicationRef(speechToText);
	const intelligenceByApplication = byApplicationRef(intelligence);

	return rows.map((application) => ({
		...application,
		...(include.textToSpeech
			? {
					textToSpeech: textToSpeechByApplication.get(application.ref) ?? null,
				}
			: {}),
		...(include.speechToText
			? {
					speechToText: speechToTextByApplication.get(application.ref) ?? null,
				}
			: {}),
		...(include.intelligence
			? {
					intelligence: intelligenceByApplication.get(application.ref) ?? null,
				}
			: {}),
	}));
}

async function insertService(
	executor: DrizzleExecutor,
	table:
		| typeof schema.textToSpeechServices
		| typeof schema.speechToTextServices
		| typeof schema.intelligenceServices,
	applicationRef: string,
	organizationId: string,
	relation?: ServiceCreate,
) {
	if (!relation) {
		return;
	}

	const { create } = relation;
	await executor.insert(table).values({
		ref: create.ref ?? uuidv4(),
		applicationRef,
		organizationId,
		productRef: create.productRef,
		config: create.config,
		credentials: encrypt(create.credentials),
	});
}

/**
 * `access_key_id` is still `not null` during the coexistence period (it is dropped in Step 9,
 * with the mapping ledger that is the sole record of which `WO…` key became which organization),
 * so a row written after the cutover has to put *something* there. It stores the organization id,
 * exactly as the per-call token's `accessKeyId` claim does since Step 4 — the value changes, the
 * shape does not, and `resolveOrganizationId` in `scripts/tenancy/plan.ts` recognises it as
 * already-scoped so a later backfill pass is a no-op on these rows.
 */
function applicationValues(data: ApplicationData) {
	return {
		...(data.ref !== undefined ? { ref: data.ref } : {}),
		...(data.organizationId !== undefined
			? { organizationId: data.organizationId, accessKeyId: data.organizationId }
			: {}),
		...(data.name !== undefined ? { name: data.name } : {}),
		...(data.type !== undefined ? { type: data.type } : {}),
		...(data.endpoint !== undefined ? { endpoint: data.endpoint } : {}),
	};
}

function createDatabase(
	executor: DrizzleExecutor,
	root: ApiDatabase,
	close: () => Promise<void>,
	inTransaction = false,
): Database {
	const runInTransaction = async <T>(callback: (database: Database) => Promise<T>) => {
		if (inTransaction) {
			return callback(database);
		}

		try {
			return await root.transaction(async (transaction) =>
				callback(
					createDatabase(
						transaction as unknown as DrizzleExecutor,
						root,
						async () => undefined,
						true,
					),
				),
			);
		} catch (error) {
			return normalizeError(error);
		}
	};

	const database: Database = {
		forOrganization(organizationId) {
			return createTenantDatabase(root, requireOrganizationId(organizationId));
		},
		application: {
			async create({ data }) {
				if (!inTransaction) {
					return runInTransaction((transaction) => transaction.application.create({ data }));
				}

				try {
					const ref = data.ref ?? uuidv4();
					const organizationId = requireOrganizationId(data.organizationId);
					const [application] = await executor
						.insert(schema.applications)
						.values({
							ref,
							organizationId,
							accessKeyId: organizationId,
							name: data.name,
							type: data.type,
							endpoint: data.endpoint,
						})
						.returning();
					await insertService(
						executor,
						schema.textToSpeechServices,
						ref,
						organizationId,
						data.textToSpeech,
					);
					await insertService(
						executor,
						schema.speechToTextServices,
						ref,
						organizationId,
						data.speechToText,
					);
					await insertService(
						executor,
						schema.intelligenceServices,
						ref,
						organizationId,
						data.intelligence,
					);
					return application;
				} catch (error) {
					return normalizeError(error);
				}
			},
			async delete({ where }) {
				try {
					const [application] = await executor
						.delete(schema.applications)
						.where(eq(schema.applications.ref, where.ref))
						.returning();
					if (!application) {
						throw notFound("Application");
					}
					return application;
				} catch (error) {
					return normalizeError(error);
				}
			},
			async findMany(args) {
				try {
					let rows: Application[];
					if (args.cursor) {
						const [cursor] = await executor
							.select({ ref: schema.applications.ref })
							.from(schema.applications)
							.where(eq(schema.applications.ref, args.cursor.ref))
							.limit(1);
						if (!cursor) {
							return [];
						}
						rows = await executor
							.select()
							.from(schema.applications)
							.where(
								and(
									eq(schema.applications.organizationId, args.where.organizationId),
									gte(schema.applications.ref, cursor.ref),
								),
							)
							.orderBy(asc(schema.applications.ref))
							.limit(args.take)
							.offset(args.skip ?? 0);
					} else {
						rows = await executor
							.select()
							.from(schema.applications)
							.where(eq(schema.applications.organizationId, args.where.organizationId))
							.limit(args.take)
							.offset(args.skip ?? 0);
					}
					return includeApplicationRelations(executor, rows, args.include);
				} catch (error) {
					return normalizeError(error);
				}
			},
			async findUnique(args) {
				try {
					const [application] = await executor
						.select()
						.from(schema.applications)
						.where(applicationConditions(args.where))
						.limit(1);
					if (!application) {
						return null;
					}
					const [result] = await includeApplicationRelations(executor, [application], args.include);
					return result;
				} catch (error) {
					return normalizeError(error);
				}
			},
			async update({ where, data }) {
				if (!inTransaction) {
					return runInTransaction((transaction) => transaction.application.update({ where, data }));
				}

				try {
					const [application] = await executor
						.update(schema.applications)
						.set(applicationValues(data))
						.where(applicationConditions(where))
						.returning();
					if (!application) {
						throw notFound("Application");
					}
					await insertService(
						executor,
						schema.textToSpeechServices,
						application.ref,
						application.organizationId,
						data.textToSpeech,
					);
					await insertService(
						executor,
						schema.speechToTextServices,
						application.ref,
						application.organizationId,
						data.speechToText,
					);
					await insertService(
						executor,
						schema.intelligenceServices,
						application.ref,
						application.organizationId,
						data.intelligence,
					);
					return application;
				} catch (error) {
					return normalizeError(error);
				}
			},
		},
		secret: {
			async create({ data }) {
				try {
					const organizationId = requireOrganizationId(data.organizationId);
					const [secret] = await executor
						.insert(schema.secrets)
						.values({
							ref: data.ref ?? uuidv4(),
							organizationId,
							// See `applicationValues` — the legacy column carries the organization id.
							accessKeyId: organizationId,
							name: data.name,
							secret: encrypt(data.secret),
						})
						.returning();
					return decryptSecret(secret);
				} catch (error) {
					return normalizeError(error);
				}
			},
			async delete({ where }) {
				try {
					const [secret] = await executor
						.delete(schema.secrets)
						.where(eq(schema.secrets.ref, where.ref))
						.returning();
					if (!secret) {
						throw notFound("Secret");
					}
					return decryptSecret(secret);
				} catch (error) {
					return normalizeError(error);
				}
			},
			async findMany(args) {
				try {
					let rows: Secret[];
					if (args.cursor) {
						const [cursor] = await executor
							.select({ ref: schema.secrets.ref })
							.from(schema.secrets)
							.where(eq(schema.secrets.ref, args.cursor.ref))
							.limit(1);
						if (!cursor) {
							return [];
						}
						rows = await executor
							.select()
							.from(schema.secrets)
							.where(
								and(
									eq(schema.secrets.organizationId, args.where.organizationId),
									gte(schema.secrets.ref, cursor.ref),
								),
							)
							.orderBy(asc(schema.secrets.ref))
							.limit(args.take)
							.offset(args.skip ?? 0);
					} else {
						rows = await executor
							.select()
							.from(schema.secrets)
							.where(eq(schema.secrets.organizationId, args.where.organizationId))
							.limit(args.take)
							.offset(args.skip ?? 0);
					}
					return rows.map(decryptSecret);
				} catch (error) {
					return normalizeError(error);
				}
			},
			async findUnique({ where }) {
				try {
					const [secret] = await executor
						.select()
						.from(schema.secrets)
						.where(eq(schema.secrets.ref, where.ref))
						.limit(1);
					return secret ? decryptSecret(secret) : null;
				} catch (error) {
					return normalizeError(error);
				}
			},
			async update({ where, data }) {
				try {
					const [secret] = await executor
						.update(schema.secrets)
						.set({
							...(data.name !== undefined ? { name: data.name } : {}),
							...(data.secret !== undefined ? { secret: encrypt(data.secret) } : {}),
						})
						.where(eq(schema.secrets.ref, where.ref))
						.returning();
					if (!secret) {
						throw notFound("Secret");
					}
					return decryptSecret(secret);
				} catch (error) {
					return normalizeError(error);
				}
			},
		},
		textToSpeech: createServiceDelegate(executor, schema.textToSpeechServices),
		speechToText: createServiceDelegate(executor, schema.speechToTextServices),
		intelligence: createServiceDelegate(executor, schema.intelligenceServices),
		product: {
			async upsert({ where, update, create }) {
				try {
					const updateValues = {
						...(update.name !== undefined ? { name: update.name } : {}),
						...(update.vendor !== undefined ? { vendor: update.vendor } : {}),
						...(update.type !== undefined ? { type: update.type } : {}),
					};
					const query = executor.insert(schema.products).values(create);
					const [product] =
						Object.keys(updateValues).length > 0
							? await query
									.onConflictDoUpdate({
										target: schema.products.ref,
										set: updateValues,
									})
									.returning()
							: await query.onConflictDoNothing({ target: schema.products.ref }).returning();
					if (product) {
						return product;
					}
					const [existing] = await executor
						.select()
						.from(schema.products)
						.where(eq(schema.products.ref, where.ref))
						.limit(1);
					return existing;
				} catch (error) {
					return normalizeError(error);
				}
			},
		},
		transaction: runInTransaction,
		close,
	};

	return database;
}

/**
 * Opens a transaction, drops into the tenant role and publishes the organization id, then hands
 * the transaction to `work`.
 *
 * `set local role` and `set_config(..., true)` are both transaction-scoped, so a pooled connection
 * is restored on commit or rollback and one tenant's scope can never leak into the next checkout.
 *
 * This reimplements `withTenantTransaction` from `@optimiq-voice/db` rather than calling it, for
 * the reason spelled out in `src/core/db/tenant.ts`: `apps/api` and `packages/db` resolve
 * different `drizzle-orm@1.0.0-rc.4` instances, so an `SQL` fragment built there cannot be handed
 * to `execute` here. `test/core/tenantContext.test.ts` pins the two statement shapes together.
 */
async function withTenantScope<T>(
	root: ApiDatabase,
	organizationId: string,
	work: (executor: DrizzleExecutor) => Promise<T>,
): Promise<T> {
	try {
		return await root.transaction(async (transaction) => {
			await transaction.execute(sql`set local role ${sql.identifier(API_TENANT_ROLE_NAME)}`);
			await transaction.execute(
				sql`select set_config(${API_TENANT_ORGANIZATION_SETTING}, ${organizationId}, true)`,
			);
			return await work(transaction as unknown as DrizzleExecutor);
		});
	} catch (error) {
		return normalizeError(error);
	}
}

/**
 * Wraps each delegate method of {@link Database} in its own tenant transaction.
 *
 * Delegating per call rather than holding a long-lived scoped handle is deliberate: a gRPC
 * handler does one or two reads, and a transaction that outlives the statement would pin a pool
 * connection for the whole request.
 */
function createTenantDatabase(root: ApiDatabase, organizationId: string): TenantDatabase {
	const scoped = <T>(work: (database: Database) => Promise<T>): Promise<T> =>
		withTenantScope(root, organizationId, (executor) =>
			work(createDatabase(executor, root, async () => undefined, true)),
		);

	const tenantDatabase: TenantDatabase = {
		organizationId,
		application: {
			create: (args) => scoped((database) => database.application.create(args)),
			delete: (args) => scoped((database) => database.application.delete(args)),
			findMany: (args) => scoped((database) => database.application.findMany(args)),
			findUnique: (args) => scoped((database) => database.application.findUnique(args)),
			update: (args) => scoped((database) => database.application.update(args)),
		},
		secret: {
			create: (args) => scoped((database) => database.secret.create(args)),
			delete: (args) => scoped((database) => database.secret.delete(args)),
			findMany: (args) => scoped((database) => database.secret.findMany(args)),
			findUnique: (args) => scoped((database) => database.secret.findUnique(args)),
			update: (args) => scoped((database) => database.secret.update(args)),
		},
		textToSpeech: {
			deleteMany: (args) => scoped((database) => database.textToSpeech.deleteMany(args)),
		},
		speechToText: {
			deleteMany: (args) => scoped((database) => database.speechToText.deleteMany(args)),
		},
		intelligence: {
			deleteMany: (args) => scoped((database) => database.intelligence.deleteMany(args)),
		},
		transaction: (callback) =>
			withTenantScope(root, organizationId, (executor) => {
				const inner = createDatabase(executor, root, async () => undefined, true);
				return callback({
					...tenantDatabase,
					organizationId,
					application: inner.application,
					secret: inner.secret,
					textToSpeech: inner.textToSpeech,
					speechToText: inner.speechToText,
					intelligence: inner.intelligence,
					transaction: (nested) => nested(tenantDatabase),
				});
			}),
	};

	return tenantDatabase;
}

function createServiceDelegate(
	executor: DrizzleExecutor,
	table:
		| typeof schema.textToSpeechServices
		| typeof schema.speechToTextServices
		| typeof schema.intelligenceServices,
): ServiceDelegate {
	return {
		async deleteMany({ where }) {
			try {
				const deleted = await executor
					.delete(table)
					.where(eq(table.applicationRef, where.applicationRef))
					.returning({ ref: table.ref });
				return { count: deleted.length };
			} catch (error) {
				return normalizeError(error);
			}
		},
	};
}

const pool = new Pool(getPoolConfig(process.env.API_DATABASE_URL as string));
// drizzle 1.0 dropped the `(client, config)` positional overload: the client is now a field of
// the single config object, and relational metadata arrives as `relations`, not `schema`.
const drizzleDb = drizzle({ client: pool, relations: schema.relations });
const db = createDatabase(drizzleDb, drizzleDb, () => pool.end());

export {
	type Application,
	type ApplicationResult,
	DATABASE_ALREADY_EXISTS,
	DATABASE_NOT_FOUND,
	type Database,
	DatabaseError,
	db,
	type TenantDatabase,
	TenantScopeError,
};
