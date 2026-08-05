import {
  decryptStringSync,
  encryptStringSync,
  findKeyForMessage,
  makeKeychainSync,
  parseCloakedString,
  parseKeySync
} from "@47ng/cloak";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { getLogger } from "@optimiq-voice/logger";
import { CLOAK_ENCRYPTION_KEY } from "../envs";
import * as schema from "./db/schema";

const logger = getLogger({ service: "api", filePath: __filename });

const DATABASE_ALREADY_EXISTS = "DATABASE_ALREADY_EXISTS" as const;
const DATABASE_NOT_FOUND = "DATABASE_NOT_FOUND" as const;

type DatabaseErrorCode =
  | typeof DATABASE_ALREADY_EXISTS
  | typeof DATABASE_NOT_FOUND;

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

type ApplicationData = Partial<
  Pick<Application, "ref" | "name" | "type" | "endpoint">
> & {
  accessKeyId?: string;
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
  where: { ref: string; accessKeyId?: string };
  include?: ApplicationInclude;
};

type FindManyApplicationArgs = {
  where: { accessKeyId: string };
  include?: ApplicationInclude;
  take: number;
  skip?: number;
  cursor?: { ref: string };
};

type SecretData = Partial<Pick<Secret, "name" | "secret">> & {
  ref?: string;
  accessKeyId?: string;
};

type FindManySecretArgs = {
  where: { accessKeyId: string };
  take: number;
  skip?: number;
  cursor?: { ref: string };
};

type DrizzleExecutor = Pick<
  NodePgDatabase<typeof schema>,
  "delete" | "insert" | "select" | "update"
>;

type ApplicationDelegate = {
  create(args: { data: ApplicationData }): Promise<Application>;
  delete(args: { where: { ref: string } }): Promise<Application>;
  findMany(args: FindManyApplicationArgs): Promise<ApplicationResult[]>;
  findUnique(
    args: FindUniqueApplicationArgs
  ): Promise<ApplicationResult | null>;
  update(args: {
    where: { ref: string; accessKeyId?: string };
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

type Database = {
  application: ApplicationDelegate;
  secret: SecretDelegate;
  textToSpeech: ServiceDelegate;
  speechToText: ServiceDelegate;
  intelligence: ServiceDelegate;
  product: ProductDelegate;
  transaction<T>(callback: (database: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

const encryptionKey = parseKeySync(CLOAK_ENCRYPTION_KEY);
const decryptionKeys = Array.from(
  new Set([
    CLOAK_ENCRYPTION_KEY,
    ...(process.env.PRISMA_FIELD_DECRYPTION_KEYS ?? "")
      .split(",")
      .filter(Boolean)
  ])
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
      error
    });
    return value;
  }
}

function decryptService(service: Service | null): Service | null {
  return service
    ? { ...service, credentials: decrypt(service.credentials) }
    : null;
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
    throw new DatabaseError(
      DATABASE_ALREADY_EXISTS,
      "The resource already exists"
    );
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
    options: `-c search_path=${databaseSchema},public`
  };
}

function applicationConditions(where: { ref: string; accessKeyId?: string }) {
  return where.accessKeyId
    ? and(
        eq(schema.applications.ref, where.ref),
        eq(schema.applications.accessKeyId, where.accessKeyId)
      )
    : eq(schema.applications.ref, where.ref);
}

async function includeApplicationRelations(
  executor: DrizzleExecutor,
  rows: Application[],
  include?: ApplicationInclude
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
      : []
  ]);

  const byApplicationRef = (services: Service[]) =>
    new Map(
      services.map((service) => [
        service.applicationRef,
        decryptService(service)
      ])
    );
  const textToSpeechByApplication = byApplicationRef(textToSpeech);
  const speechToTextByApplication = byApplicationRef(speechToText);
  const intelligenceByApplication = byApplicationRef(intelligence);

  return rows.map((application) => ({
    ...application,
    ...(include.textToSpeech
      ? {
          textToSpeech: textToSpeechByApplication.get(application.ref) ?? null
        }
      : {}),
    ...(include.speechToText
      ? {
          speechToText: speechToTextByApplication.get(application.ref) ?? null
        }
      : {}),
    ...(include.intelligence
      ? {
          intelligence: intelligenceByApplication.get(application.ref) ?? null
        }
      : {})
  }));
}

async function insertService(
  executor: DrizzleExecutor,
  table:
    | typeof schema.textToSpeechServices
    | typeof schema.speechToTextServices
    | typeof schema.intelligenceServices,
  applicationRef: string,
  relation?: ServiceCreate
) {
  if (!relation) {
    return;
  }

  const { create } = relation;
  await executor.insert(table).values({
    ref: create.ref ?? uuidv4(),
    applicationRef,
    productRef: create.productRef,
    config: create.config,
    credentials: encrypt(create.credentials)
  });
}

function applicationValues(data: ApplicationData) {
  return {
    ...(data.ref !== undefined ? { ref: data.ref } : {}),
    ...(data.accessKeyId !== undefined
      ? { accessKeyId: data.accessKeyId }
      : {}),
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.type !== undefined ? { type: data.type } : {}),
    ...(data.endpoint !== undefined ? { endpoint: data.endpoint } : {})
  };
}

function createDatabase(
  executor: DrizzleExecutor,
  root: NodePgDatabase<typeof schema>,
  close: () => Promise<void>,
  inTransaction = false
): Database {
  const runInTransaction = async <T>(
    callback: (database: Database) => Promise<T>
  ) => {
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
            true
          )
        )
      );
    } catch (error) {
      return normalizeError(error);
    }
  };

  const database: Database = {
    application: {
      async create({ data }) {
        if (!inTransaction) {
          return runInTransaction((transaction) =>
            transaction.application.create({ data })
          );
        }

        try {
          const ref = data.ref ?? uuidv4();
          const [application] = await executor
            .insert(schema.applications)
            .values({
              ref,
              accessKeyId: data.accessKeyId,
              name: data.name,
              type: data.type,
              endpoint: data.endpoint
            })
            .returning();
          await insertService(
            executor,
            schema.textToSpeechServices,
            ref,
            data.textToSpeech
          );
          await insertService(
            executor,
            schema.speechToTextServices,
            ref,
            data.speechToText
          );
          await insertService(
            executor,
            schema.intelligenceServices,
            ref,
            data.intelligence
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
                  eq(schema.applications.accessKeyId, args.where.accessKeyId),
                  gte(schema.applications.ref, cursor.ref)
                )
              )
              .orderBy(asc(schema.applications.ref))
              .limit(args.take)
              .offset(args.skip ?? 0);
          } else {
            rows = await executor
              .select()
              .from(schema.applications)
              .where(
                eq(schema.applications.accessKeyId, args.where.accessKeyId)
              )
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
          const [result] = await includeApplicationRelations(
            executor,
            [application],
            args.include
          );
          return result;
        } catch (error) {
          return normalizeError(error);
        }
      },
      async update({ where, data }) {
        if (!inTransaction) {
          return runInTransaction((transaction) =>
            transaction.application.update({ where, data })
          );
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
            data.textToSpeech
          );
          await insertService(
            executor,
            schema.speechToTextServices,
            application.ref,
            data.speechToText
          );
          await insertService(
            executor,
            schema.intelligenceServices,
            application.ref,
            data.intelligence
          );
          return application;
        } catch (error) {
          return normalizeError(error);
        }
      }
    },
    secret: {
      async create({ data }) {
        try {
          const [secret] = await executor
            .insert(schema.secrets)
            .values({
              ref: data.ref ?? uuidv4(),
              accessKeyId: data.accessKeyId,
              name: data.name,
              secret: encrypt(data.secret)
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
                  eq(schema.secrets.accessKeyId, args.where.accessKeyId),
                  gte(schema.secrets.ref, cursor.ref)
                )
              )
              .orderBy(asc(schema.secrets.ref))
              .limit(args.take)
              .offset(args.skip ?? 0);
          } else {
            rows = await executor
              .select()
              .from(schema.secrets)
              .where(eq(schema.secrets.accessKeyId, args.where.accessKeyId))
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
              ...(data.secret !== undefined
                ? { secret: encrypt(data.secret) }
                : {})
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
      }
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
            ...(update.type !== undefined ? { type: update.type } : {})
          };
          const query = executor.insert(schema.products).values(create);
          const [product] =
            Object.keys(updateValues).length > 0
              ? await query
                  .onConflictDoUpdate({
                    target: schema.products.ref,
                    set: updateValues
                  })
                  .returning()
              : await query
                  .onConflictDoNothing({ target: schema.products.ref })
                  .returning();
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
      }
    },
    transaction: runInTransaction,
    close
  };

  return database;
}

function createServiceDelegate(
  executor: DrizzleExecutor,
  table:
    | typeof schema.textToSpeechServices
    | typeof schema.speechToTextServices
    | typeof schema.intelligenceServices
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
    }
  };
}

const pool = new Pool(getPoolConfig(process.env.API_DATABASE_URL as string));
const drizzleDb = drizzle(pool, { schema });
const db = createDatabase(drizzleDb, drizzleDb, () => pool.end());

export {
  Application,
  ApplicationResult,
  DATABASE_ALREADY_EXISTS,
  DATABASE_NOT_FOUND,
  Database,
  DatabaseError,
  db
};
