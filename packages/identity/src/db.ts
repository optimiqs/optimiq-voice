import { randomUUID } from "node:crypto";
import {
  decryptStringSync,
  encryptStringSync,
  findKeyForMessage,
  makeKeychainSync,
  parseCloakedString,
  ParsedCloakKey,
  parseKeySync
} from "@47ng/cloak";
import {
  and,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lt,
  or,
  SQL
} from "drizzle-orm";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { AnyPgColumn } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import {
  apiKeys,
  JsonValue,
  users,
  verificationCodes,
  workspaceMembers,
  workspaces
} from "./db/schema";
import * as schema from "./db/schema";

type Role = "USER" | "WORKSPACE_ADMIN" | "WORKSPACE_OWNER" | "WORKSPACE_MEMBER";
type MemberStatus = "PENDING" | "ACTIVE";
type VerificationType = "EMAIL" | "PHONE";

type User = typeof users.$inferSelect;
type Workspace = typeof workspaces.$inferSelect;
type WorkspaceMember = typeof workspaceMembers.$inferSelect;
type ApiKey = typeof apiKeys.$inferSelect;
type VerificationCode = typeof verificationCodes.$inferSelect;

type UserResult = User & {
  memberships?: Array<WorkspaceMemberResult>;
  ownedWorkspaces?: WorkspaceResult[];
};
type WorkspaceResult = Workspace & {
  apiKeys?: ApiKeyResult[];
  members?: WorkspaceMemberResult[];
  owner?: UserResult;
};
type WorkspaceMemberResult = WorkspaceMember & {
  user?: UserResult;
  workspace?: WorkspaceResult;
};
type ApiKeyResult = ApiKey & { workspace?: WorkspaceResult };

type ScalarWhere<T> = {
  [K in keyof T]?: T[K] | null;
};

type UserWhere = ScalarWhere<
  Pick<User, "accessKeyId" | "email" | "phoneNumber" | "ref">
>;
type WorkspaceWhere = ScalarWhere<Pick<Workspace, "ownerRef" | "ref">> & {
  OR?: WorkspaceWhere[];
  accessKeyId?: string | { in?: string[] };
  members?: {
    some: ScalarWhere<
      Pick<WorkspaceMember, "role" | "status" | "userRef" | "workspaceRef">
    >;
  };
};
type WorkspaceMemberWhere = ScalarWhere<
  Pick<WorkspaceMember, "ref" | "role" | "status" | "userRef" | "workspaceRef">
>;
type ApiKeyWhere = ScalarWhere<
  Pick<ApiKey, "accessKeyId" | "ref" | "role" | "workspaceRef">
>;
type VerificationCodeWhere = ScalarWhere<
  Pick<VerificationCode, "code" | "ref" | "type" | "value">
> & {
  expiresAt?: Date | { lt?: Date };
};

type UserCreateInput = {
  accessKeyId: string;
  avatar?: string | null;
  createdAt?: Date;
  email: string;
  emailVerified?: boolean;
  extended?: JsonValue | null;
  name: string;
  password: string;
  phoneNumber?: string | null;
  phoneNumberVerified?: boolean;
  ref?: string;
  updatedAt?: Date;
};
type UserUpdateInput = Partial<Omit<UserCreateInput, "ref">>;
type WorkspaceCreateInput = {
  accessKeyId: string;
  createdAt?: Date;
  name: string;
  ownerRef: string;
  ref?: string;
  updatedAt?: Date;
};
type WorkspaceUpdateInput = Partial<Omit<WorkspaceCreateInput, "ref">>;
type WorkspaceMemberCreateInput = {
  createdAt?: Date;
  ref?: string;
  role?: Role;
  status?: MemberStatus;
  updatedAt?: Date;
  userRef: string;
  workspaceRef: string;
};
type WorkspaceMemberUpdateInput = Partial<
  Omit<WorkspaceMemberCreateInput, "ref">
>;
type ApiKeyCreateInput = {
  accessKeyId: string;
  accessKeySecret: string;
  createdAt?: Date;
  expiresAt?: Date | null;
  ref?: string;
  role?: Role;
  updatedAt?: Date;
  workspaceRef: string;
};
type ApiKeyUpdateInput = Partial<Omit<ApiKeyCreateInput, "ref">>;
type VerificationCodeCreateInput = {
  code: string;
  createdAt?: Date;
  expiresAt: Date;
  ref?: string;
  type: VerificationType;
  value: string;
};
type VerificationCodeUpdateInput = Partial<
  Omit<VerificationCodeCreateInput, "ref">
>;

type QueryOptions<W> = {
  cursor?: { ref: string };
  include?: Record<string, boolean | { include?: object; select?: object }>;
  select?: Record<string, boolean>;
  skip?: number;
  take?: number;
  where?: W;
};

type Delegate<R, C, U, W> = {
  create(args: QueryOptions<W> & { data: C }): Promise<R>;
  delete(args: QueryOptions<W> & { where: W }): Promise<R>;
  deleteMany(args?: QueryOptions<W>): Promise<{ count: number }>;
  findFirst(args?: QueryOptions<W>): Promise<R | null>;
  findMany(args?: QueryOptions<W>): Promise<R[]>;
  findUnique(args: QueryOptions<W> & { where: W }): Promise<R | null>;
  update(args: QueryOptions<W> & { data: U; where: W }): Promise<R>;
  upsert(
    args: QueryOptions<W> & { create: C; update: U; where: W }
  ): Promise<R>;
};

type Database = {
  apiKey: Delegate<
    ApiKeyResult,
    ApiKeyCreateInput,
    ApiKeyUpdateInput,
    ApiKeyWhere
  >;
  close(): Promise<void>;
  transaction<T>(callback: (db: Database) => Promise<T>): Promise<T>;
  user: Delegate<UserResult, UserCreateInput, UserUpdateInput, UserWhere>;
  verificationCode: Delegate<
    VerificationCode,
    VerificationCodeCreateInput,
    VerificationCodeUpdateInput,
    VerificationCodeWhere
  >;
  workspace: Delegate<
    WorkspaceResult,
    WorkspaceCreateInput,
    WorkspaceUpdateInput,
    WorkspaceWhere
  >;
  workspaceMember: Delegate<
    WorkspaceMemberResult,
    WorkspaceMemberCreateInput,
    WorkspaceMemberUpdateInput,
    WorkspaceMemberWhere
  >;
};

type Encryption = {
  currentKey: ParsedCloakKey;
  keychain: ReturnType<typeof makeKeychainSync>;
};

const DATABASE_ALREADY_EXISTS = "DATABASE_ALREADY_EXISTS";
const DATABASE_NOT_FOUND = "DATABASE_NOT_FOUND";

function createDatabaseError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
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

async function execute<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (hasErrorCode(error, "23505")) {
      throw createDatabaseError(
        DATABASE_ALREADY_EXISTS,
        "A record with the same unique fields already exists"
      );
    }
    throw error;
  }
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

function createEncryption(cloakEncryptionKey: string): Encryption {
  const fallbackKeys = (process.env.PRISMA_FIELD_DECRYPTION_KEYS ?? "")
    .split(",")
    .filter(Boolean);
  const keys = Array.from(new Set([cloakEncryptionKey, ...fallbackKeys]));

  return {
    currentKey: parseKeySync(cloakEncryptionKey),
    keychain: makeKeychainSync(keys)
  };
}

function encrypt(value: string | null | undefined, encryption: Encryption) {
  if (value === null || value === undefined) return value;
  return encryptStringSync(value, encryption.currentKey);
}

function decrypt(value: string | null | undefined, encryption: Encryption) {
  if (value === null || value === undefined || !parseCloakedString(value)) {
    return value;
  }

  try {
    const key = findKeyForMessage(value, encryption.keychain);
    return decryptStringSync(value, key);
  } catch (error) {
    console.error(
      `[database-encryption] Error: decryption error(s) encountered: ${error}`
    );
    return value;
  }
}

function decryptUser(user: User, encryption: Encryption): UserResult {
  return { ...user, password: decrypt(user.password, encryption) };
}

function decryptApiKey(apiKey: ApiKey, encryption: Encryption): ApiKeyResult {
  return {
    ...apiKey,
    accessKeySecret: decrypt(apiKey.accessKeySecret, encryption)
  };
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as T;
}

function addEquals(conditions: SQL[], column: AnyPgColumn, value: unknown) {
  if (value === undefined) return;
  conditions.push(value === null ? isNull(column) : eq(column, value));
}

function userCondition(where: UserWhere = {}) {
  const conditions: SQL[] = [];
  addEquals(conditions, users.ref, where.ref);
  addEquals(conditions, users.accessKeyId, where.accessKeyId);
  addEquals(conditions, users.email, where.email);
  addEquals(conditions, users.phoneNumber, where.phoneNumber);
  return and(...conditions);
}

function workspaceMemberCondition(where: WorkspaceMemberWhere = {}) {
  const conditions: SQL[] = [];
  addEquals(conditions, workspaceMembers.ref, where.ref);
  addEquals(conditions, workspaceMembers.userRef, where.userRef);
  addEquals(conditions, workspaceMembers.workspaceRef, where.workspaceRef);
  addEquals(conditions, workspaceMembers.status, where.status);
  addEquals(conditions, workspaceMembers.role, where.role);
  return and(...conditions);
}

function workspaceCondition(
  db: NodePgDatabase<typeof schema>,
  where: WorkspaceWhere = {}
): SQL | undefined {
  const conditions: SQL[] = [];
  addEquals(conditions, workspaces.ref, where.ref);
  addEquals(conditions, workspaces.ownerRef, where.ownerRef);

  if (typeof where.accessKeyId === "string" || where.accessKeyId === null) {
    addEquals(conditions, workspaces.accessKeyId, where.accessKeyId);
  } else if (where.accessKeyId?.in) {
    conditions.push(inArray(workspaces.accessKeyId, where.accessKeyId.in));
  }

  if (where.members?.some) {
    conditions.push(
      exists(
        db
          .select({ ref: workspaceMembers.ref })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceRef, workspaces.ref),
              workspaceMemberCondition(where.members.some)
            )
          )
      )
    );
  }

  if (where.OR) {
    conditions.push(
      or(...where.OR.map((item) => workspaceCondition(db, item)))
    );
  }

  return and(...conditions);
}

function apiKeyCondition(where: ApiKeyWhere = {}) {
  const conditions: SQL[] = [];
  addEquals(conditions, apiKeys.ref, where.ref);
  addEquals(conditions, apiKeys.accessKeyId, where.accessKeyId);
  addEquals(conditions, apiKeys.workspaceRef, where.workspaceRef);
  addEquals(conditions, apiKeys.role, where.role);
  return and(...conditions);
}

function verificationCodeCondition(where: VerificationCodeWhere = {}) {
  const conditions: SQL[] = [];
  addEquals(conditions, verificationCodes.ref, where.ref);
  addEquals(conditions, verificationCodes.type, where.type);
  addEquals(conditions, verificationCodes.value, where.value);
  addEquals(conditions, verificationCodes.code, where.code);
  if (where.expiresAt instanceof Date) {
    addEquals(conditions, verificationCodes.expiresAt, where.expiresAt);
  } else if (where.expiresAt?.lt) {
    conditions.push(lt(verificationCodes.expiresAt, where.expiresAt.lt));
  }
  return and(...conditions);
}

function withCursor(
  condition: SQL | undefined,
  column: AnyPgColumn,
  cursor?: { ref: string }
) {
  return cursor ? and(condition, gte(column, cursor.ref)) : condition;
}

function project<T extends Record<string, unknown>>(
  record: T,
  select?: Record<string, boolean>
): T {
  if (!select) return record;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => select[key])
  ) as T;
}

function createDatabase(
  db: NodePgDatabase<typeof schema>,
  encryption: Encryption,
  close: () => Promise<void>
): Database {
  async function includeUser(
    record: User,
    include?: QueryOptions<UserWhere>["include"]
  ): Promise<UserResult> {
    const user = decryptUser(record, encryption);
    if (include?.ownedWorkspaces) {
      user.ownedWorkspaces = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.ownerRef, user.ref));
    }
    if (include?.memberships) {
      const memberships = await db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userRef, user.ref));
      const membershipInclude = include.memberships as { include?: object };
      user.memberships = await Promise.all(
        memberships.map((membership) =>
          includeWorkspaceMember(
            membership,
            membershipInclude.include as Record<string, boolean | object>
          )
        )
      );
    }
    return user;
  }

  async function includeWorkspace(
    record: Workspace,
    include?: QueryOptions<WorkspaceWhere>["include"]
  ): Promise<WorkspaceResult> {
    const workspace: WorkspaceResult = { ...record };
    if (include?.owner) {
      const [owner] = await db
        .select()
        .from(users)
        .where(eq(users.ref, workspace.ownerRef))
        .limit(1);
      const ownerInclude = include.owner as {
        select?: Record<string, boolean>;
      };
      workspace.owner = owner
        ? project(decryptUser(owner, encryption), ownerInclude.select)
        : undefined;
    }
    if (include?.members) {
      workspace.members = await db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceRef, workspace.ref));
    }
    return workspace;
  }

  async function includeWorkspaceMember(
    record: WorkspaceMember,
    include?: Record<string, boolean | object>
  ): Promise<WorkspaceMemberResult> {
    const member: WorkspaceMemberResult = { ...record };
    if (include?.user) {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.ref, member.userRef))
        .limit(1);
      member.user = user ? decryptUser(user, encryption) : undefined;
    }
    if (include?.workspace) {
      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.ref, member.workspaceRef))
        .limit(1);
      member.workspace = workspace;
    }
    return member;
  }

  async function includeApiKey(
    record: ApiKey,
    include?: QueryOptions<ApiKeyWhere>["include"]
  ): Promise<ApiKeyResult> {
    const apiKey = decryptApiKey(record, encryption);
    if (include?.workspace) {
      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.ref, apiKey.workspaceRef))
        .limit(1);
      apiKey.workspace = workspace;
    }
    return apiKey;
  }

  const user: Database["user"] = {
    async create(args) {
      return execute(async () => {
        const data = compact({
          ...args.data,
          ref: args.data.ref ?? randomUUID(),
          password: encrypt(args.data.password, encryption)
        });
        const [record] = await db.insert(users).values(data).returning();
        return project(await includeUser(record, args.include), args.select);
      });
    },
    async delete(args) {
      return execute(async () => {
        const [record] = await db
          .delete(users)
          .where(userCondition(args.where))
          .returning();
        if (!record) {
          throw createDatabaseError(DATABASE_NOT_FOUND, "User not found");
        }
        return project(await includeUser(record, args.include), args.select);
      });
    },
    async deleteMany(args = {}) {
      return execute(async () => {
        const records = await db
          .delete(users)
          .where(userCondition(args.where))
          .returning({ ref: users.ref });
        return { count: records.length };
      });
    },
    async findFirst(args = {}) {
      const records = await user.findMany({ ...args, take: 1 });
      return records[0] ?? null;
    },
    async findMany(args = {}) {
      return execute(async () => {
        let query = db
          .select()
          .from(users)
          .where(withCursor(userCondition(args.where), users.ref, args.cursor))
          .$dynamic();
        if (args.cursor) query = query.orderBy(users.ref);
        if (args.skip) query = query.offset(args.skip);
        if (args.take !== undefined) query = query.limit(args.take);
        const records = await query;
        return Promise.all(
          records.map(async (record) =>
            project(await includeUser(record, args.include), args.select)
          )
        );
      });
    },
    async findUnique(args) {
      return user.findFirst(args);
    },
    async update(args) {
      return execute(async () => {
        const data = compact({
          ...args.data,
          password:
            args.data.password === undefined
              ? undefined
              : encrypt(args.data.password, encryption)
        });
        const [record] = await db
          .update(users)
          .set(data)
          .where(userCondition(args.where))
          .returning();
        if (!record) {
          throw createDatabaseError(DATABASE_NOT_FOUND, "User not found");
        }
        return project(await includeUser(record, args.include), args.select);
      });
    },
    async upsert(args) {
      return execute(async () => {
        const create = compact({
          ...args.create,
          ref: args.create.ref ?? randomUUID(),
          password: encrypt(args.create.password, encryption)
        });
        const update = compact({
          ...args.update,
          password:
            args.update.password === undefined
              ? undefined
              : encrypt(args.update.password, encryption)
        });
        const [record] = await db
          .insert(users)
          .values(create)
          .onConflictDoUpdate({ target: users.ref, set: update })
          .returning();
        return project(await includeUser(record, args.include), args.select);
      });
    }
  };

  const workspace: Database["workspace"] = {
    async create(args) {
      return execute(async () => {
        const [record] = await db
          .insert(workspaces)
          .values(compact({ ...args.data, ref: args.data.ref ?? randomUUID() }))
          .returning();
        return project(
          await includeWorkspace(record, args.include),
          args.select
        );
      });
    },
    async delete(args) {
      return execute(async () => {
        const [record] = await db
          .delete(workspaces)
          .where(workspaceCondition(db, args.where))
          .returning();
        if (!record) {
          throw createDatabaseError(DATABASE_NOT_FOUND, "Workspace not found");
        }
        return project(
          await includeWorkspace(record, args.include),
          args.select
        );
      });
    },
    async deleteMany(args = {}) {
      return execute(async () => {
        const records = await db
          .delete(workspaces)
          .where(workspaceCondition(db, args.where))
          .returning({ ref: workspaces.ref });
        return { count: records.length };
      });
    },
    async findFirst(args = {}) {
      const records = await workspace.findMany({ ...args, take: 1 });
      return records[0] ?? null;
    },
    async findMany(args = {}) {
      return execute(async () => {
        let query = db
          .select()
          .from(workspaces)
          .where(
            withCursor(
              workspaceCondition(db, args.where),
              workspaces.ref,
              args.cursor
            )
          )
          .$dynamic();
        if (args.cursor) query = query.orderBy(workspaces.ref);
        if (args.skip) query = query.offset(args.skip);
        if (args.take !== undefined) query = query.limit(args.take);
        const records = await query;
        return Promise.all(
          records.map(async (record) =>
            project(await includeWorkspace(record, args.include), args.select)
          )
        );
      });
    },
    async findUnique(args) {
      return workspace.findFirst(args);
    },
    async update(args) {
      return execute(async () => {
        const [record] = await db
          .update(workspaces)
          .set(compact(args.data))
          .where(workspaceCondition(db, args.where))
          .returning();
        if (!record) {
          throw createDatabaseError(DATABASE_NOT_FOUND, "Workspace not found");
        }
        return project(
          await includeWorkspace(record, args.include),
          args.select
        );
      });
    },
    async upsert(args) {
      return execute(async () => {
        const create = compact({
          ...args.create,
          ref: args.create.ref ?? randomUUID()
        });
        const update = compact(args.update);
        let records: Workspace[];
        if (Object.keys(update).length === 0) {
          records = await db
            .insert(workspaces)
            .values(create)
            .onConflictDoNothing({ target: workspaces.ref })
            .returning();
          if (records.length === 0) {
            records = await db
              .select()
              .from(workspaces)
              .where(workspaceCondition(db, args.where))
              .limit(1);
          }
        } else {
          records = await db
            .insert(workspaces)
            .values(create)
            .onConflictDoUpdate({ target: workspaces.ref, set: update })
            .returning();
        }
        return project(
          await includeWorkspace(records[0], args.include),
          args.select
        );
      });
    }
  };

  const workspaceMember: Database["workspaceMember"] = {
    async create(args) {
      return execute(async () => {
        const [record] = await db
          .insert(workspaceMembers)
          .values(compact({ ...args.data, ref: args.data.ref ?? randomUUID() }))
          .returning();
        return project(
          await includeWorkspaceMember(record, args.include),
          args.select
        );
      });
    },
    async delete(args) {
      return execute(async () => {
        const [record] = await db
          .delete(workspaceMembers)
          .where(workspaceMemberCondition(args.where))
          .returning();
        if (!record) {
          throw createDatabaseError(
            DATABASE_NOT_FOUND,
            "Workspace member not found"
          );
        }
        return project(
          await includeWorkspaceMember(record, args.include),
          args.select
        );
      });
    },
    async deleteMany(args = {}) {
      return execute(async () => {
        const records = await db
          .delete(workspaceMembers)
          .where(workspaceMemberCondition(args.where))
          .returning({ ref: workspaceMembers.ref });
        return { count: records.length };
      });
    },
    async findFirst(args = {}) {
      const records = await workspaceMember.findMany({ ...args, take: 1 });
      return records[0] ?? null;
    },
    async findMany(args = {}) {
      return execute(async () => {
        let query = db
          .select()
          .from(workspaceMembers)
          .where(
            withCursor(
              workspaceMemberCondition(args.where),
              workspaceMembers.ref,
              args.cursor
            )
          )
          .$dynamic();
        if (args.cursor) query = query.orderBy(workspaceMembers.ref);
        if (args.skip) query = query.offset(args.skip);
        if (args.take !== undefined) query = query.limit(args.take);
        const records = await query;
        return Promise.all(
          records.map(async (record) =>
            project(
              await includeWorkspaceMember(record, args.include),
              args.select
            )
          )
        );
      });
    },
    async findUnique(args) {
      return workspaceMember.findFirst(args);
    },
    async update(args) {
      return execute(async () => {
        const [record] = await db
          .update(workspaceMembers)
          .set(compact(args.data))
          .where(workspaceMemberCondition(args.where))
          .returning();
        if (!record) {
          throw createDatabaseError(
            DATABASE_NOT_FOUND,
            "Workspace member not found"
          );
        }
        return project(
          await includeWorkspaceMember(record, args.include),
          args.select
        );
      });
    },
    async upsert(args) {
      return execute(async () => {
        const [record] = await db
          .insert(workspaceMembers)
          .values(
            compact({ ...args.create, ref: args.create.ref ?? randomUUID() })
          )
          .onConflictDoUpdate({
            target: workspaceMembers.ref,
            set: compact(args.update)
          })
          .returning();
        return project(
          await includeWorkspaceMember(record, args.include),
          args.select
        );
      });
    }
  };

  const apiKey: Database["apiKey"] = {
    async create(args) {
      return execute(async () => {
        const [record] = await db
          .insert(apiKeys)
          .values(
            compact({
              ...args.data,
              ref: args.data.ref ?? randomUUID(),
              accessKeySecret: encrypt(args.data.accessKeySecret, encryption)
            })
          )
          .returning();
        return project(await includeApiKey(record, args.include), args.select);
      });
    },
    async delete(args) {
      return execute(async () => {
        const [record] = await db
          .delete(apiKeys)
          .where(apiKeyCondition(args.where))
          .returning();
        if (!record) {
          throw createDatabaseError(DATABASE_NOT_FOUND, "API key not found");
        }
        return project(await includeApiKey(record, args.include), args.select);
      });
    },
    async deleteMany(args = {}) {
      return execute(async () => {
        const records = await db
          .delete(apiKeys)
          .where(apiKeyCondition(args.where))
          .returning({ ref: apiKeys.ref });
        return { count: records.length };
      });
    },
    async findFirst(args = {}) {
      const records = await apiKey.findMany({ ...args, take: 1 });
      return records[0] ?? null;
    },
    async findMany(args = {}) {
      return execute(async () => {
        let query = db
          .select()
          .from(apiKeys)
          .where(
            withCursor(apiKeyCondition(args.where), apiKeys.ref, args.cursor)
          )
          .$dynamic();
        if (args.cursor) query = query.orderBy(apiKeys.ref);
        if (args.skip) query = query.offset(args.skip);
        if (args.take !== undefined) query = query.limit(args.take);
        const records = await query;
        return Promise.all(
          records.map(async (record) =>
            project(await includeApiKey(record, args.include), args.select)
          )
        );
      });
    },
    async findUnique(args) {
      return apiKey.findFirst(args);
    },
    async update(args) {
      return execute(async () => {
        const data = compact({
          ...args.data,
          accessKeySecret:
            args.data.accessKeySecret === undefined
              ? undefined
              : encrypt(args.data.accessKeySecret, encryption)
        });
        const [record] = await db
          .update(apiKeys)
          .set(data)
          .where(apiKeyCondition(args.where))
          .returning();
        if (!record) {
          throw createDatabaseError(DATABASE_NOT_FOUND, "API key not found");
        }
        return project(await includeApiKey(record, args.include), args.select);
      });
    },
    async upsert(args) {
      return execute(async () => {
        const create = compact({
          ...args.create,
          ref: args.create.ref ?? randomUUID(),
          accessKeySecret: encrypt(args.create.accessKeySecret, encryption)
        });
        const update = compact({
          ...args.update,
          accessKeySecret:
            args.update.accessKeySecret === undefined
              ? undefined
              : encrypt(args.update.accessKeySecret, encryption)
        });
        const [record] = await db
          .insert(apiKeys)
          .values(create)
          .onConflictDoUpdate({ target: apiKeys.ref, set: update })
          .returning();
        return project(await includeApiKey(record, args.include), args.select);
      });
    }
  };

  const verificationCode: Database["verificationCode"] = {
    async create(args) {
      return execute(async () => {
        const [record] = await db
          .insert(verificationCodes)
          .values(compact({ ...args.data, ref: args.data.ref ?? randomUUID() }))
          .returning();
        return project(record, args.select);
      });
    },
    async delete(args) {
      return execute(async () => {
        const [record] = await db
          .delete(verificationCodes)
          .where(verificationCodeCondition(args.where))
          .returning();
        if (!record) {
          throw createDatabaseError(
            DATABASE_NOT_FOUND,
            "Verification code not found"
          );
        }
        return project(record, args.select);
      });
    },
    async deleteMany(args = {}) {
      return execute(async () => {
        const records = await db
          .delete(verificationCodes)
          .where(verificationCodeCondition(args.where))
          .returning({ ref: verificationCodes.ref });
        return { count: records.length };
      });
    },
    async findFirst(args = {}) {
      const records = await verificationCode.findMany({ ...args, take: 1 });
      return records[0] ?? null;
    },
    async findMany(args = {}) {
      return execute(async () => {
        let query = db
          .select()
          .from(verificationCodes)
          .where(
            withCursor(
              verificationCodeCondition(args.where),
              verificationCodes.ref,
              args.cursor
            )
          )
          .$dynamic();
        if (args.cursor) query = query.orderBy(verificationCodes.ref);
        if (args.skip) query = query.offset(args.skip);
        if (args.take !== undefined) query = query.limit(args.take);
        const records = await query;
        return records.map((record) => project(record, args.select));
      });
    },
    async findUnique(args) {
      return verificationCode.findFirst(args);
    },
    async update(args) {
      return execute(async () => {
        const [record] = await db
          .update(verificationCodes)
          .set(compact(args.data))
          .where(verificationCodeCondition(args.where))
          .returning();
        if (!record) {
          throw createDatabaseError(
            DATABASE_NOT_FOUND,
            "Verification code not found"
          );
        }
        return project(record, args.select);
      });
    },
    async upsert(args) {
      return execute(async () => {
        const [record] = await db
          .insert(verificationCodes)
          .values(
            compact({ ...args.create, ref: args.create.ref ?? randomUUID() })
          )
          .onConflictDoUpdate({
            target: verificationCodes.ref,
            set: compact(args.update)
          })
          .returning();
        return project(record, args.select);
      });
    }
  };

  return {
    apiKey,
    close,
    transaction: (callback) =>
      db.transaction((transaction) =>
        callback(createDatabase(transaction, encryption, async () => undefined))
      ),
    user,
    verificationCode,
    workspace,
    workspaceMember
  };
}

function createDatabaseClient(
  dbUrl: string,
  cloakEncryptionKey: string
): Database {
  const pool = new Pool(getPoolConfig(dbUrl));
  const db = drizzle(pool, { schema });
  const encryption = createEncryption(cloakEncryptionKey);
  return createDatabase(db, encryption, () => pool.end());
}

export {
  createDatabaseClient,
  Database,
  DATABASE_ALREADY_EXISTS,
  DATABASE_NOT_FOUND
};
